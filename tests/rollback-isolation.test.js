import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

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

// Prevent real provider.deploy during rollback isolation tests
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

const {
  recordEnvDeployment,
  loadEnvArtifactHistory,
  uploadToAll,
} = await import('../src/storage/index.js');
const {
  rollbackToVersion,
  formatRollbackAllSummary,
} = await import('../src/utils/rollback/engine.js');
const {
  envHistoryRemoteKey,
  buildArtifactRemoteKey,
  historyRemoteKey,
} = await import('../src/utils/build-id.js');

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

describe('rollback --env production isolation (no previous)', () => {
  /** @type {string} */
  let tmpZip;
  /** @type {string} */
  let tmpCwd;
  /** @type {ReturnType<typeof createMemoryProvider>} */
  let mem;

  beforeEach(async () => {
    mockProviders.clear();
    rollbackCalls.length = 0;
    mem = createMemoryProvider();
    mockProviders.set('local', mem);
    tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-iso-cwd-'));
    tmpZip = path.join(tmpCwd, 'artifact.zip');
    await fs.writeFile(tmpZip, 'fake-zip');
  });

  afterEach(async () => {
    await fs.remove(tmpCwd).catch(() => {});
  });

  test('deploy A→testing, deploy B→production; rollback --env production fails — does NOT use testing history or project catalog', async () => {
    const config = {
      project: 'demo-app',
      version: '1.0.0',
      buildId: '1.0.0-aaa',
      defaultEnvironment: 'production',
      legacyHistoryMigrated: true,
      storage: ['local'],
      environments: {
        testing: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: { host: 't' },
        },
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: { host: 'p' },
        },
      },
    };

    // Build catalog gets both uploads (simulates build-once catalog pollution)
    await uploadToAll(['local'], tmpZip, { ...config, buildId: '1.0.0-aaa' });
    await uploadToAll(['local'], tmpZip, { ...config, buildId: '1.0.0-bbb' });
    expect(mem.store.has(historyRemoteKey('demo-app'))).toBe(true);

    // Deploy A → testing (two entries so testing WOULD have a previous if we wrongly used it)
    await recordEnvDeployment(['local'], tmpZip, config, 'testing', {
      buildId: '1.0.0-old-test',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-old-test'),
    });
    await recordEnvDeployment(['local'], tmpZip, config, 'testing', {
      buildId: '1.0.0-aaa',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-aaa'),
    });

    // Deploy B → production (ONLY one entry)
    await recordEnvDeployment(['local'], tmpZip, { ...config, buildId: '1.0.0-bbb' }, 'production', {
      buildId: '1.0.0-bbb',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-bbb'),
    });

    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'production'))).toBe(true);
    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'testing'))).toBe(true);

    // Prove env history itself is isolated (only B). Legacy catalog still has A+B for list --remote.
    const prodHist = await loadEnvArtifactHistory(['local'], 'demo-app', 'production', {
      allowLegacyFallback: false,
    });
    expect(prodHist.entries.map((e) => e.buildId)).toEqual(['1.0.0-bbb']);
    expect(prodHist.legacyFallback).toBeUndefined();

    // Even WITH legacy fallback enabled, existing env key must win (no catalog merge).
    const withLegacy = await loadEnvArtifactHistory(['local'], 'demo-app', 'production', {
      defaultEnvironment: 'production',
      allowLegacyFallback: true,
    });
    expect(withLegacy.entries.map((e) => e.buildId)).toEqual(['1.0.0-bbb']);

    // Rollback with allowLegacyFallback forced off (engine behavior)
    await expect(
      rollbackToVersion(config, undefined, tmpCwd, {
        envNames: ['production'],
      })
    ).rejects.toThrow(/No previous build found for environment "production"/);

    expect(rollbackCalls).toHaveLength(0);

    // Even if production env history were MISSING, must not fall back to catalog/testing
    mem.store.delete(envHistoryRemoteKey('demo-app', 'production'));
    await expect(
      rollbackToVersion(config, undefined, tmpCwd, {
        envNames: ['production'],
      })
    ).rejects.toThrow(/No previous build found for environment "production"/);

    // And must not have resolved testing's previous build
    expect(rollbackCalls.find((c) => c.buildId === '1.0.0-old-test')).toBeUndefined();
  });

  test('legacy history [C,B,A] migrates to default env; rollback --env default resolves to B', async () => {
    const legacyEntries = [
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
    ];
    mem.store.set(historyRemoteKey('demo-app'), JSON.stringify(legacyEntries));
    mem.store.set(buildArtifactRemoteKey('demo-app', 'build-B'), Buffer.from('zip-b'));
    mem.store.set(buildArtifactRemoteKey('demo-app', 'build-C'), Buffer.from('zip-c'));

    const config = {
      project: 'demo-app',
      version: '3.0.0',
      buildId: 'build-C',
      defaultEnvironment: 'default',
      storage: ['local'],
      environments: {
        default: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: { host: '127.0.0.1' },
        },
      },
    };

    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'default'))).toBe(false);

    const { results } = await rollbackToVersion(config, undefined, tmpCwd, {
      envNames: ['default'],
    });

    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'default'))).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].entry.buildId).toBe('build-B');
    expect(rollbackCalls).toEqual([{ envName: 'default', buildId: 'build-B' }]);
  });

  test('rollback uses only envs/{env}/history.json — allowLegacyFallback false in engine', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src/utils/rollback/engine.js'),
      'utf8'
    );
    expect(src).toMatch(/allowLegacyFallback:\s*false/);
    expect(src).not.toMatch(/defaultEnvironment:\s*resolveDefaultEnvironmentName/);
  });
});

describe('rollback --env all continue-on-error', () => {
  /** @type {string} */
  let tmpZip;
  /** @type {string} */
  let tmpCwd;
  /** @type {ReturnType<typeof createMemoryProvider>} */
  let mem;

  beforeEach(async () => {
    mockProviders.clear();
    rollbackCalls.length = 0;
    mem = createMemoryProvider();
    mockProviders.set('local', mem);
    tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-all-cwd-'));
    tmpZip = path.join(tmpCwd, 'artifact.zip');
    await fs.writeFile(tmpZip, 'fake-zip');
  });

  afterEach(async () => {
    await fs.remove(tmpCwd).catch(() => {});
  });

  test('one env fails mid --env all: others still complete, summary reports, failures non-empty', async () => {
    const config = {
      project: 'demo-app',
      version: '1.0.0',
      storage: ['local'],
      defaultEnvironment: 'development',
      environments: {
        development: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: {},
        },
        testing: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: {},
        },
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: {},
        },
      },
    };

    // development + testing have 2 deploys each; production has only 1 → will fail no-previous
    for (const env of ['development', 'testing']) {
      await recordEnvDeployment(['local'], tmpZip, config, env, {
        buildId: `${env}-old`,
        semver: '1.0.0',
        remoteKey: buildArtifactRemoteKey('demo-app', `${env}-old`),
      });
      await recordEnvDeployment(['local'], tmpZip, config, env, {
        buildId: `${env}-new`,
        semver: '1.0.0',
        remoteKey: buildArtifactRemoteKey('demo-app', `${env}-new`),
      });
    }
    await recordEnvDeployment(['local'], tmpZip, config, 'production', {
      buildId: 'production-only',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', 'production-only'),
    });

    // Seed zip bytes under build keys so download works for successful envs
    for (const id of ['development-old', 'testing-old']) {
      mem.store.set(buildArtifactRemoteKey('demo-app', id), Buffer.from('zip'));
    }

    const { results, failures } = await rollbackToVersion(config, undefined, tmpCwd, {
      envNames: ['development', 'testing', 'production'],
      continueOnError: true,
    });

    expect(results.map((r) => r.envName).sort()).toEqual(['development', 'testing']);
    expect(results.find((r) => r.envName === 'development').entry.buildId).toBe('development-old');
    expect(results.find((r) => r.envName === 'testing').entry.buildId).toBe('testing-old');

    expect(failures).toHaveLength(1);
    expect(failures[0].envName).toBe('production');
    expect(failures[0].error).toMatch(/No previous build found for environment "production"/);

    const summary = formatRollbackAllSummary(results, failures);
    expect(summary).toContain('✓ development');
    expect(summary).toContain('✓ testing');
    expect(summary).toContain('✗ production');
    expect(summary).toContain('1 of 3 environments failed');
  });
});
