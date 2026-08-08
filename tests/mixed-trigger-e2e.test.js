/**
 * Permanent regression guard for the mixed-trigger E2E flow:
 *   push build → only trigger=push envs deploy
 *   workflow_dispatch deploy --env <manual>
 *   workflow_dispatch deploy --env all
 *   rollback --env all with divergent per-env histories
 *
 * SSH is mocked; real pipeline / deployToAll / rollbackToVersion / local storage.
 * Uses DEPLOYHUB_LOCAL_STORAGE_DIR instead of process.chdir (parallel-safe).
 */
import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

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
const {
  rollbackToVersion,
  formatRollbackAllSummary,
} = await import('../src/utils/rollback/engine.js');
const { uploadToAll, loadEnvArtifactHistory } = await import(
  '../src/storage/index.js'
);
const { createArtifact } = await import('../src/artifact/engine.js');
const { resolveBuildId } = await import('../src/utils/build-id.js');

describe('mixed-trigger E2E (push / dispatch / rollback --env all)', () => {
  jest.setTimeout(120_000);

  /** @type {string} */
  let sim;
  /** @type {Record<string, any>} */
  let config;
  /** @type {string|undefined} */
  let prevStorageDir;

  beforeEach(async () => {
    sim = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-mixed-e2e-'));
    await fs.ensureDir(path.join(sim, 'dist'));
    await fs.writeFile(path.join(sim, 'dist', 'index.html'), '<html>ok</html>');
    await fs.writeJson(path.join(sim, 'package.json'), {
      name: 'demo-mixed',
      version: '1.0.0',
    });
    const keyPath = path.join(sim, 'fake-key');
    await fs.writeFile(
      keyPath,
      '-----BEGIN FAKE KEY-----\nmock\n-----END FAKE KEY-----\n'
    );

    prevStorageDir = process.env.DEPLOYHUB_LOCAL_STORAGE_DIR;
    process.env.DEPLOYHUB_LOCAL_STORAGE_DIR = path.join(
      sim,
      '.deployhub-storage'
    );

    config = {
      project: 'demo-mixed',
      projectType: 'frontend',
      framework: 'react',
      version: '1.0.0',
      buildOutput: 'dist',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
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
        development: {
          enabled: true,
          method: 'ec2',
          trigger: 'push',
          config: {
            host: 'dev.example.com',
            user: 'ubuntu',
            deployPath: '/var/www/dev',
            keyPath,
          },
        },
        production: {
          enabled: true,
          method: 'ec2',
          trigger: 'manual',
          config: {
            host: 'prod.example.com',
            user: 'ubuntu',
            deployPath: '/var/www/prod',
            keyPath,
          },
        },
      },
    };
    await fs.writeJson(path.join(sim, 'deployhub.config.json'), config, {
      spaces: 2,
    });

    process.env.SSH_KEY =
      '-----BEGIN FAKE KEY-----\nmock-dev\n-----END FAKE KEY-----\n';
    process.env.PRODUCTION_SSH_KEY =
      '-----BEGIN FAKE KEY-----\nmock-prod\n-----END FAKE KEY-----\n';
    process.env.PRODUCTION_SSH_HOST = 'prod.example.com';
    process.env.PRODUCTION_SSH_USER = 'ubuntu';
  });

  afterEach(async () => {
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_EVENT_NAME;
    if (prevStorageDir === undefined) {
      delete process.env.DEPLOYHUB_LOCAL_STORAGE_DIR;
    } else {
      process.env.DEPLOYHUB_LOCAL_STORAGE_DIR = prevStorageDir;
    }
    await fs.remove(sim);
  });

  test('push build deploys only trigger=push; dispatch + rollback --env all work independently of trigger', async () => {
    // --- 1) Push-triggered build ---
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_EVENT_NAME = 'push';

    expect(
      pipelineDeployTargets(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
      })
    ).toEqual(['development']);

    /** @type {Record<string, unknown>} */
    const state = {};
    const stages = buildPipelineStages(config, sim, state).filter((s) =>
      ['artifact', 'storage', 'deploy'].includes(s.name)
    );
    const { failure } = await runPipeline(stages, { config, cwd: sim, state });
    expect(failure).toBeNull();
    expect(state.deployedTargets).toEqual(['development']);
    expect(state.deployedTargets).not.toContain('production');

    // --- 2) workflow_dispatch deploy --env production (manual) ---
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    expect(
      pipelineDeployTargets(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
      })
    ).toEqual([]);

    const { targets: prodTargets } = resolveEnvTargets(config, 'production');
    expect(prodTargets).toEqual(['production']);
    const artifactDir = /** @type {string} */ (state.artifactDir);
    const deployedProd = await deployToAll(config, artifactDir, prodTargets);
    expect(deployedProd).toEqual(['production']);

    // --- 3) workflow_dispatch deploy --env all ---
    const { targets: allTargets } = resolveEnvTargets(config, 'all');
    expect(allTargets).toEqual(['development', 'production']);
    const deployedAll = await deployToAll(config, artifactDir, allTargets);
    expect(deployedAll).toEqual(['development', 'production']);

    // --- 4) Seed second build on BOTH, then production-only third build ---
    config.version = '1.0.1';
    const { buildId: b101 } = resolveBuildId({ semver: '1.0.1' });
    config.buildId = b101;
    const art101 = await createArtifact(config, [], sim);
    await uploadToAll(config.storage, art101.zipPath, config);
    await deployToAll(config, art101.artifactDir, ['development', 'production']);

    config.version = '1.0.2';
    const { buildId: b102 } = resolveBuildId({ semver: '1.0.2' });
    config.buildId = b102;
    await fs.writeFile(path.join(sim, 'dist', 'index.html'), '<html>v102</html>');
    const art102 = await createArtifact(config, [], sim);
    await uploadToAll(config.storage, art102.zipPath, config);
    await deployToAll(config, art102.artifactDir, ['production']);

    const devH = await loadEnvArtifactHistory(
      ['local'],
      config.project,
      'development',
      { allowLegacyFallback: false }
    );
    const prodH = await loadEnvArtifactHistory(
      ['local'],
      config.project,
      'production',
      { allowLegacyFallback: false }
    );
    expect(devH.entries[0].buildId).toMatch(/^1\.0\.1-/);
    expect(prodH.entries[0].buildId).toMatch(/^1\.0\.2-/);
    expect(devH.entries[0].buildId).not.toBe(prodH.entries[0].buildId);

    // --- 5) rollback --env all (trigger irrelevant) ---
    const { targets: rbTargets, skippedDisabled } = resolveEnvTargets(
      config,
      'all'
    );
    const { results, failures } = await rollbackToVersion(
      config,
      undefined,
      sim,
      { envNames: rbTargets, continueOnError: true }
    );
    expect(failures).toEqual([]);
    expect(results).toHaveLength(2);

    const byEnv = Object.fromEntries(
      results.map((r) => [r.envName, r.entry.buildId])
    );
    expect(byEnv.development).toMatch(/^1\.0\.0-/);
    expect(byEnv.production).toMatch(/^1\.0\.1-/);
    expect(byEnv.development).not.toBe(byEnv.production);

    const summary = formatRollbackAllSummary(
      results,
      failures,
      skippedDisabled
    );
    expect(summary).toContain('development');
    expect(summary).toContain('production');
    expect(summary).toMatch(/rolled back successfully/i);
  });
});
