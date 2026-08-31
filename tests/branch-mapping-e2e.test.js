/**
 * Real pipeline evidence for per-environment branch mapping:
 *   1. generated YAML on.push.branches === [main, dev]
 *   2. unmapped branch (akash) is not in the trigger list (GHA would never invoke)
 *   3. GITHUB_REF=refs/heads/dev deploys only staging → envs/staging/...
 *   4. GITHUB_REF=refs/heads/main deploys only production → envs/production/...
 *   5. workflow_dispatch --env still selects an environment explicitly
 *   6. staging rollback history only contains buildIds from the dev-branch run
 *
 * SSH is mocked; pipeline / deployToAll / recordEnvDeployment / local storage are real.
 */
import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async putFile() {}
    async execCommand(cmd) {
      const c = String(cmd);
      if (/\btest -f\b/.test(c)) {
        return { code: 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { pipelineDeployTargets, buildPipelineStages } = await import(
  '../src/core/stages.js'
);
const { runPipeline } = await import('../src/core/pipeline.js');
const { deployToAll } = await import('../src/deployment/index.js');
const { resolveEnvTargets } = await import('../src/core/environments.js');
const { generateWorkflowYaml } = await import('../src/utils/github-actions.js');
const { loadEnvArtifactHistory } = await import('../src/storage/index.js');
const { envHistoryRemoteKey, envLatestArtifactRemoteKey } = await import(
  '../src/utils/build-id.js'
);
const { resolveRollbackTarget } = await import('../src/utils/artifact-history.js');

describe('branch mapping E2E (real pipeline + local storage)', () => {
  jest.setTimeout(120_000);

  /** @type {string} */
  let sim;
  /** @type {Record<string, any>} */
  let config;
  /** @type {string|undefined} */
  let prevStorageDir;
  /** @type {string} */
  let storageDir;

  beforeEach(async () => {
    sim = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-branch-map-'));
    await fs.ensureDir(path.join(sim, 'dist'));
    await fs.writeFile(path.join(sim, 'dist', 'index.html'), '<html>ok</html>');
    await fs.writeJson(path.join(sim, 'package.json'), {
      name: 'demo-branch-map',
      version: '1.0.0',
    });
    const keyPath = path.join(sim, 'fake-key');
    await fs.writeFile(
      keyPath,
      '-----BEGIN FAKE KEY-----\nmock\n-----END FAKE KEY-----\n'
    );

    storageDir = path.join(sim, '.deployhub-storage');
    prevStorageDir = process.env.DEPLOYHUB_LOCAL_STORAGE_DIR;
    process.env.DEPLOYHUB_LOCAL_STORAGE_DIR = storageDir;

    config = {
      project: 'demo-branch-map',
      projectType: 'frontend',
      framework: 'react',
      version: '1.0.0',
      buildOutput: 'dist',
      defaultEnvironment: 'production',
      unprefixedSecretEnvironment: 'production',
      storage: ['local'],
      pipeline: {
        install: false,
        test: false,
        build: false,
        docker: false,
        deploy: true,
        notify: false,
        verify: false,
      },
      artifact: true,
      environments: {
        production: {
          enabled: true,
          method: 'ec2',
          trigger: 'push',
          branch: 'main',
          config: {
            host: 'prod.example.com',
            user: 'ubuntu',
            deployPath: '/var/www/prod',
            keyPath,
          },
        },
        staging: {
          enabled: true,
          method: 'ec2',
          trigger: 'push',
          branch: 'dev',
          config: {
            host: 'stg.example.com',
            user: 'ubuntu',
            deployPath: '/var/www/stg',
            keyPath,
          },
        },
      },
    };
    await fs.writeJson(path.join(sim, 'deployhub.config.json'), config, {
      spaces: 2,
    });

    process.env.SSH_KEY =
      '-----BEGIN FAKE KEY-----\nmock-prod\n-----END FAKE KEY-----\n';
    process.env.STAGING_SSH_KEY =
      '-----BEGIN FAKE KEY-----\nmock-stg\n-----END FAKE KEY-----\n';
    process.env.STAGING_SSH_HOST = 'stg.example.com';
    process.env.STAGING_SSH_USER = 'ubuntu';
  });

  afterEach(async () => {
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_REF;
    delete process.env.GITHUB_REF_NAME;
    if (prevStorageDir === undefined) {
      delete process.env.DEPLOYHUB_LOCAL_STORAGE_DIR;
    } else {
      process.env.DEPLOYHUB_LOCAL_STORAGE_DIR = prevStorageDir;
    }
    await fs.remove(sim);
  });

  /**
   * @param {string} ref
   * @param {string} version
   */
  async function runPushPipeline(ref, version) {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_EVENT_NAME = 'push';
    process.env.GITHUB_REF = ref;
    config.version = version;
    config.buildId = undefined;
    /** @type {Record<string, unknown>} */
    const state = {};
    const stages = buildPipelineStages(config, sim, state).filter((s) =>
      ['artifact', 'storage', 'deploy'].includes(s.name)
    );
    const { failure } = await runPipeline(stages, { config, cwd: sim, state });
    expect(failure).toBeNull();
    return state;
  }

  test('all 6 cases: YAML trigger list, unmapped exclusion, dev/main runs, dispatch, staging history', async () => {
    // --- 1 + 2) Generated workflow YAML ---
    const yamlText = generateWorkflowYaml(
      ['local'],
      ['production', 'staging'],
      config.environments,
      'npm:@akash-chowdhury-24/deployhub',
      config
    );
    const parsed = yaml.load(yamlText);
    expect(parsed.on.push.branches).toEqual(['main', 'dev']);
    expect(parsed.on.push.branches).not.toContain('akash');
    expect(yamlText).toContain('branches: [main, dev]');
    // Method: inspect generated YAML trigger list (GitHub would never invoke
    // this workflow for a push to `akash` because it is not in on.push.branches).
    expect(JSON.stringify(parsed.on.push.branches)).not.toMatch(/akash/);

    // --- 3) Simulated push to `dev` → staging only ---
    const devState = await runPushPipeline('refs/heads/dev', '1.0.0');
    expect(devState.deployedTargets).toEqual(['staging']);
    expect(devState.deployedTargets).not.toContain('production');

    const stagingHistAfterDev = await loadEnvArtifactHistory(
      ['local'],
      config.project,
      'staging',
      { allowLegacyFallback: false }
    );
    const prodHistAfterDev = await loadEnvArtifactHistory(
      ['local'],
      config.project,
      'production',
      { allowLegacyFallback: false }
    );
    expect(stagingHistAfterDev.entries).toHaveLength(1);
    expect(prodHistAfterDev.entries).toHaveLength(0);
    const stagingBuildFromDev = stagingHistAfterDev.entries[0].buildId;
    expect(stagingBuildFromDev).toMatch(/^1\.0\.0-/);

    const stagingLatest = envLatestArtifactRemoteKey(config.project, 'staging');
    const prodLatest = envLatestArtifactRemoteKey(config.project, 'production');
    expect(await fs.pathExists(path.join(storageDir, stagingLatest))).toBe(true);
    expect(await fs.pathExists(path.join(storageDir, prodLatest))).toBe(false);
    expect(stagingLatest).toMatch(/envs\/staging\//);
    expect(prodLatest).toMatch(/envs\/production\//);

    // --- 4) Simulated push to `main` → production only ---
    const mainState = await runPushPipeline('refs/heads/main', '1.0.1');
    expect(mainState.deployedTargets).toEqual(['production']);
    expect(mainState.deployedTargets).not.toContain('staging');

    const stagingHistAfterMain = await loadEnvArtifactHistory(
      ['local'],
      config.project,
      'staging',
      { allowLegacyFallback: false }
    );
    const prodHistAfterMain = await loadEnvArtifactHistory(
      ['local'],
      config.project,
      'production',
      { allowLegacyFallback: false }
    );
    expect(prodHistAfterMain.entries).toHaveLength(1);
    expect(prodHistAfterMain.entries[0].buildId).toMatch(/^1\.0\.1-/);
    expect(stagingHistAfterMain.entries).toHaveLength(1);
    expect(stagingHistAfterMain.entries[0].buildId).toBe(stagingBuildFromDev);
    expect(await fs.pathExists(path.join(storageDir, prodLatest))).toBe(true);

    // --- 5) workflow_dispatch still picks an environment explicitly ---
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    expect(
      pipelineDeployTargets(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/dev',
      })
    ).toEqual([]);
    const { targets: dispatchTargets } = resolveEnvTargets(config, 'production');
    expect(dispatchTargets).toEqual(['production']);
    const dispatched = await deployToAll(
      config,
      /** @type {string} */ (mainState.artifactDir),
      dispatchTargets
    );
    expect(dispatched).toEqual(['production']);
    expect(parsed.on.workflow_dispatch.inputs.environment.options).toEqual([
      'production',
      'staging',
      'all',
    ]);

    // --- 6) staging rollback history is only the dev-branch build ---
    const stagingFinal = await loadEnvArtifactHistory(
      ['local'],
      config.project,
      'staging',
      { allowLegacyFallback: false }
    );
    const stagingIds = stagingFinal.entries.map((e) => e.buildId);
    expect(stagingIds).toEqual([stagingBuildFromDev]);
    expect(stagingIds.every((id) => id.startsWith('1.0.0-'))).toBe(true);
    expect(stagingIds.some((id) => String(id).startsWith('1.0.1-'))).toBe(false);

    const prodIds = (
      await loadEnvArtifactHistory(['local'], config.project, 'production', {
        allowLegacyFallback: false,
      })
    ).entries.map((e) => e.buildId);
    expect(prodIds.every((id) => id !== stagingBuildFromDev)).toBe(true);

    const resolved = resolveRollbackTarget(stagingFinal.entries, undefined);
    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe('no-previous');
    const historyKey = envHistoryRemoteKey(config.project, 'staging');
    expect(historyKey).toBe('demo-branch-map/envs/staging/history.json');
    expect(await fs.pathExists(path.join(storageDir, historyKey))).toBe(true);
  });
});
