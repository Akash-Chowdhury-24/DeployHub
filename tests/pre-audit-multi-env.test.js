import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

const mockProviders = new Map();

jest.unstable_mockModule('../src/storage/providers/aws.js', () => ({
  createAwsProvider: () => mockProviders.get('aws'),
}));
jest.unstable_mockModule('../src/storage/providers/local.js', () => ({
  createLocalProvider: () => mockProviders.get('local'),
}));
jest.unstable_mockModule('../src/storage/providers/azure.js', () => ({
  createAzureProvider: () => mockProviders.get('azure'),
}));
jest.unstable_mockModule('../src/storage/providers/gcp.js', () => ({
  createGcpProvider: () => mockProviders.get('gcp'),
}));
jest.unstable_mockModule('../src/storage/providers/gdrive.js', () => ({
  createGdriveProvider: () => mockProviders.get('gdrive'),
}));
jest.unstable_mockModule('../src/storage/providers/dropbox.js', () => ({
  createDropboxProvider: () => mockProviders.get('dropbox'),
}));
jest.unstable_mockModule('../src/storage/providers/ftp.js', () => ({
  createFtpProvider: () => mockProviders.get('ftp'),
}));

const rollbackCalls = [];
jest.unstable_mockModule('../src/deployment/index.js', () => ({
  getDeploymentProvider: (_type, _config, envName) => ({
    async rollback(_artifactDir, meta) {
      rollbackCalls.push({ envName, buildId: meta.buildId });
    },
    async deploy() {},
  }),
  deployToAll: async () => [],
  rollbackAll: async () => {},
}));

jest.unstable_mockModule('../src/artifact/engine.js', () => ({
  extractArtifact: async () => {},
  createArtifact: async () => ({ artifactDir: '', zipPath: '' }),
  listLocalArtifacts: async () => [],
  repackArtifactZip: async () => {},
}));

function createMemoryProvider() {
  /** @type {Map<string, Buffer|string>} */
  const store = new Map();
  return {
    store,
    async upload(localPath, remoteKey) {
      store.set(remoteKey, await fs.readFile(localPath));
    },
    async download(remoteKey, localPath) {
      const data = store.get(remoteKey);
      if (!data) throw new Error(`missing ${remoteKey}`);
      await fs.ensureDir(path.dirname(localPath));
      await fs.writeFile(localPath, data);
    },
    async verify(remoteKey) {
      return store.has(remoteKey);
    },
    async delete(remoteKey) {
      store.delete(remoteKey);
    },
    async testConnection() {},
  };
}

const {
  ensureLegacyHistoryCopiedToDefaultEnv,
  recordEnvDeployment,
  loadEnvArtifactHistory,
} = await import('../src/storage/index.js');
const { rollbackToVersion } = await import('../src/utils/rollback/engine.js');
const {
  loadConfig,
  migrateConfigToEnvironments,
  validateConfigConsistency,
} = await import('../src/core/config.js');
const { resolveEnvTargets } = await import('../src/core/environments.js');
const { runPipeline } = await import('../src/core/pipeline.js');
const {
  envHistoryRemoteKey,
  envLatestArtifactRemoteKey,
  buildArtifactRemoteKey,
  historyRemoteKey,
} = await import('../src/utils/build-id.js');
const {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  extractWorkflowSecretKeys,
} = await import('../src/utils/github-actions.js');

describe('A — legacy history guard (sibling env deployed first)', () => {
  /** @type {ReturnType<typeof createMemoryProvider>} */
  let mem;
  /** @type {string} */
  let tmpZip;
  /** @type {string} */
  let tmpCwd;

  beforeEach(async () => {
    mockProviders.clear();
    rollbackCalls.length = 0;
    mem = createMemoryProvider();
    mockProviders.set('local', mem);
    tmpZip = path.join(os.tmpdir(), `dh-audit-zip-${Date.now()}.zip`);
    tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-audit-cwd-'));
    await fs.writeFile(tmpZip, 'fake-zip');

    mem.store.set(
      historyRemoteKey('demo-app'),
      JSON.stringify([
        {
          buildId: 'build-C',
          semver: '3.0.0',
          uploadedAt: '2026-03-03T00:00:00.000Z',
          remoteKey: buildArtifactRemoteKey('demo-app', 'build-C'),
        },
        {
          buildId: 'build-B',
          semver: '2.0.0',
          uploadedAt: '2026-03-02T00:00:00.000Z',
          remoteKey: buildArtifactRemoteKey('demo-app', 'build-B'),
        },
        {
          buildId: 'build-A',
          semver: '1.0.0',
          uploadedAt: '2026-03-01T00:00:00.000Z',
          remoteKey: buildArtifactRemoteKey('demo-app', 'build-A'),
        },
      ])
    );
    mem.store.set(buildArtifactRemoteKey('demo-app', 'build-B'), Buffer.from('zip-b'));
    mem.store.set(buildArtifactRemoteKey('demo-app', 'build-C'), Buffer.from('zip-c'));
  });

  afterEach(async () => {
    await fs.remove(tmpZip).catch(() => {});
    await fs.remove(tmpCwd).catch(() => {});
  });

  test('testing deployed first does not block default rollback from recovering legacy history', async () => {
    const config = {
      project: 'demo-app',
      version: '3.0.0',
      storage: ['local'],
      defaultEnvironment: 'default',
      // Simulates shape-migrated legacy project (no legacyHistoryMigrated — not init-native).
      environments: {
        default: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: { host: '127.0.0.1' },
        },
        testing: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: { host: '10.0.0.2' },
        },
      },
    };

    await recordEnvDeployment(['local'], tmpZip, config, 'testing', {
      buildId: '1.0.0-testing-only',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-testing-only'),
    });
    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'testing'))).toBe(true);
    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'default'))).toBe(false);

    const { results } = await rollbackToVersion(config, undefined, tmpCwd, {
      envNames: ['default'],
    });

    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'default'))).toBe(true);
    expect(results[0].entry.buildId).toBe('build-B');
    expect(rollbackCalls).toEqual([{ envName: 'default', buildId: 'build-B' }]);
  });

  test('init-native legacyHistoryMigrated skips catalog copy on default rollback', async () => {
    await recordEnvDeployment(['local'], tmpZip, {
      project: 'demo-app',
      storage: ['local'],
      defaultEnvironment: 'default',
      legacyHistoryMigrated: true,
      environments: {
        default: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    }, 'default', {
      buildId: '1.0.0-only',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-only'),
    });

    const copied = await ensureLegacyHistoryCopiedToDefaultEnv(
      ['local'],
      'demo-app',
      'default',
      { legacyHistoryMigrated: true }
    );
    expect(copied).toBe(false);
    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'default'))).toBe(true);
    expect(mem.store.get(envHistoryRemoteKey('demo-app', 'default')).toString()).not.toContain('build-C');
  });
});

describe('B — config schema edge cases', () => {
  test('B1: defaultEnvironment typo fails at validateConfigConsistency', () => {
    expect(() =>
      validateConfigConsistency({
        defaultEnvironment: 'typo-env',
        environments: {
          production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
        },
      })
    ).toThrow(/defaultEnvironment "typo-env" is not defined/);
  });

  test('B2: deploy with disabled defaultEnvironment fails loudly', () => {
    expect(() =>
      resolveEnvTargets(
        {
          defaultEnvironment: 'production',
          environments: {
            production: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
            staging: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
          },
        },
        undefined
      )
    ).toThrow(/Environment "production" is disabled/);
  });

  test('B5: flat config migration with empty storage array does not crash', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-migrate-empty-storage-'));
    try {
      const configPath = path.join(tmp, 'deployhub.config.json');
      await fs.writeJson(configPath, {
        project: 'demo',
        type: 'ssh',
        host: '1.2.3.4',
        storage: [],
      });

      const loaded = await loadConfig(tmp);
      expect(loaded.environments.default.method).toBe('ssh');
      expect(loaded.storage).toEqual([]);
    } finally {
      await fs.remove(tmp);
    }
  });

  test('B5: migrateConfigToEnvironments with storage:[] is idempotent', () => {
    const { config, migrated } = migrateConfigToEnvironments({
      project: 'demo',
      type: 'ssh',
      host: 'x',
      storage: [],
    });
    expect(migrated).toBe(true);
    expect(config.storage).toEqual([]);
    expect(config.environments.default).toBeTruthy();
  });
});

describe('C — CLI resolveEnvTargets edge cases', () => {
  const base = {
    defaultEnvironment: 'production',
    environments: {
      production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      staging: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
    },
  };

  test('C1: unknown --env name fails with not found', () => {
    expect(() => resolveEnvTargets(base, 'doesNotExist')).toThrow(
      /Environment "doesNotExist" not found/
    );
  });

  test('C2: --env all with zero enabled returns empty targets', () => {
    expect(
      resolveEnvTargets(
        {
          defaultEnvironment: 'a',
          environments: {
            a: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
            b: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
          },
        },
        'all'
      )
    ).toEqual({ targets: [], skippedDisabled: ['a', 'b'] });
  });

  test('C5: enable/disable paths use not found (exercised via resolveEnvTargets on missing)', () => {
    expect(() => resolveEnvTargets({ environments: {} }, 'nope')).toThrow(/not found/);
  });
});

describe('C3 — pipeline stops before deploy when earlier stage fails', () => {
  test('deploy stage not reached when test stage throws', async () => {
    let deployRan = false;
    const { failure, completed } = await runPipeline(
      [
        { name: 'test', async run() { throw new Error('tests failed'); } },
        {
          name: 'storage',
          async run() {},
        },
        {
          name: 'deploy',
          async run() {
            deployRan = true;
          },
        },
      ],
      { config: { storage: ['local'] }, cwd: process.cwd(), state: {} }
    );

    expect(failure?.message).toMatch(/tests failed/);
    expect(completed).not.toContain('deploy');
    expect(deployRan).toBe(false);
  });
});

describe('D — storage isolation', () => {
  /** @type {ReturnType<typeof createMemoryProvider>} */
  let mem;
  /** @type {string} */
  let tmpZip;

  beforeEach(async () => {
    mockProviders.clear();
    mem = createMemoryProvider();
    mockProviders.set('local', mem);
    tmpZip = path.join(os.tmpdir(), `dh-d-zip-${Date.now()}.zip`);
    await fs.writeFile(tmpZip, 'zip-bytes');
  });

  test('D2: per-env latest keys are distinct', async () => {
    const config = { project: 'demo-app', version: '1.0.0', storage: ['local'] };
    await recordEnvDeployment(['local'], tmpZip, config, 'production', {
      buildId: '1.0.0-prod',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-prod'),
    });
    await recordEnvDeployment(['local'], tmpZip, config, 'testing', {
      buildId: '1.0.0-test',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-test'),
    });

    const prodLatest = envLatestArtifactRemoteKey('demo-app', 'production');
    const testLatest = envLatestArtifactRemoteKey('demo-app', 'testing');
    expect(prodLatest).not.toBe(testLatest);
    expect(mem.store.has(prodLatest)).toBe(true);
    expect(mem.store.has(testLatest)).toBe(true);
  });
});

describe('F — workflow generation (3 envs)', () => {
  const environments = {
    development: {
      enabled: true,
      method: 'ssh',
      trigger: 'push',
      config: {},
    },
    staging: {
      enabled: true,
      method: 'docker',
      trigger: 'manual',
      config: {},
    },
    production: {
      enabled: true,
      method: 'kubernetes',
      trigger: 'manual',
      config: { kubeNamespace: 'prod' },
    },
  };
  const config = {
    project: 'demo',
    projectType: 'frontend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments,
  };
  const deployEnvs = ['development', 'staging', 'production'];
  const CLI = 'npm:@akash-chowdhury-24/deployhub';

  test('F1/F2: push trigger only on development; dispatch lists all + all; secret parity', () => {
    const deployYaml = generateWorkflowYaml(
      ['aws'],
      deployEnvs,
      environments,
      CLI,
      config
    );
    const rollbackYaml = generateRollbackWorkflowYaml(
      ['aws'],
      deployEnvs,
      environments,
      CLI,
      config
    );

    expect(deployYaml).toContain('push:');
    expect(deployYaml).toMatch(/branches:[\s\S]*main/);
    expect(deployYaml).toContain('- development');
    expect(deployYaml).toContain('- staging');
    expect(deployYaml).toContain('- production');
    expect(deployYaml).toContain('- all');
    expect(deployYaml).toContain('SSH_HOST: ${{ secrets.SSH_HOST }}');

    // Step-scoped assertions (file-level "contains" missed Build vs dispatch split).
    const parsed = yaml.load(deployYaml);
    const buildStep = parsed.jobs.deploy.steps.find((s) =>
      String(s.name || '').includes('Build')
    );
    const dispatchStep = parsed.jobs.deploy.steps.find((s) =>
      String(s.name || '').includes('workflow_dispatch')
    );
    expect(buildStep.env.SSH_HOST).toBe('${{ secrets.SSH_HOST }}');
    // Build: push-triggered development only — no manual staging/production secrets.
    expect(buildStep.env.STAGING_DOCKER_REGISTRY_USERNAME).toBeUndefined();
    expect(buildStep.env.PRODUCTION_KUBECONFIG).toBeUndefined();
    // Dispatch: union of ALL enabled envs (dropdown can select staging/production/all).
    expect(dispatchStep.env.STAGING_DOCKER_REGISTRY_USERNAME).toBe(
      '${{ secrets.STAGING_DOCKER_REGISTRY_USERNAME }}'
    );
    expect(rollbackYaml).toContain('STAGING_');
    expect(rollbackYaml).toContain('PRODUCTION_');

    const deploySecrets = extractWorkflowSecretKeys(deployYaml);
    const rollbackSecrets = new Set(extractWorkflowSecretKeys(rollbackYaml));
    for (const key of deploySecrets) {
      expect(rollbackSecrets.has(key)).toBe(true);
    }
    expect(new Set(deploySecrets).size).toBe(deploySecrets.length);
  });

  test('F3: regeneration is byte-identical when config unchanged', () => {
    const first = generateWorkflowYaml(['aws'], deployEnvs, environments, CLI, config);
    const second = generateWorkflowYaml(['aws'], deployEnvs, environments, CLI, config);
    expect(second).toBe(first);

    const rb1 = generateRollbackWorkflowYaml(['aws'], deployEnvs, environments, CLI, config);
    const rb2 = generateRollbackWorkflowYaml(['aws'], deployEnvs, environments, CLI, config);
    expect(rb2).toBe(rb1);
  });
});
