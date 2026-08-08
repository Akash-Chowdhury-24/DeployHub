/**
 * Real pipeline / deploy / rollback simulation for config #3 (mixed trigger).
 * SSH is mocked via --import register.mjs (fake node-ssh); providers are real.
 */
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipelineDeployTargets, buildPipelineStages } from '../src/core/stages.js';
import { runPipeline } from '../src/core/pipeline.js';
import { deployToAll } from '../src/deployment/index.js';
import { resolveEnvTargets } from '../src/core/environments.js';
import {
  rollbackToVersion,
  formatRollbackAllSummary,
} from '../src/utils/rollback/engine.js';
import { recordEnvDeployment, uploadToAll } from '../src/storage/index.js';
import { createArtifact } from '../src/artifact/engine.js';
import { resolveBuildId } from '../src/utils/build-id.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(ROOT, 'sim', 'mixed-trigger');
const LOGS = path.join(ROOT, 'logs');

const config = {
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
        keyPath: path.join(SIM, 'fake-key'),
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
        keyPath: path.join(SIM, 'fake-key'),
      },
    },
  },
};

async function setupProject() {
  await fs.emptyDir(SIM);
  await fs.ensureDir(path.join(SIM, 'dist'));
  await fs.writeFile(path.join(SIM, 'dist', 'index.html'), '<html>ok</html>');
  await fs.writeJson(path.join(SIM, 'package.json'), {
    name: 'demo-mixed',
    version: '1.0.0',
  });
  await fs.writeJson(path.join(SIM, 'deployhub.config.json'), config, { spaces: 2 });
  await fs.writeFile(path.join(SIM, 'fake-key'), '-----BEGIN FAKE KEY-----\nmock\n-----END FAKE KEY-----\n');
  // CI secret overlay ambient for production (prefixed) — present even when not targeted
  process.env.SSH_KEY = '-----BEGIN FAKE KEY-----\nmock-dev\n-----END FAKE KEY-----\n';
  process.env.PRODUCTION_SSH_KEY =
    '-----BEGIN FAKE KEY-----\nmock-prod\n-----END FAKE KEY-----\n';
  process.env.PRODUCTION_SSH_HOST = 'prod.example.com';
  process.env.PRODUCTION_SSH_USER = 'ubuntu';
}

function banner(title) {
  const line = '='.repeat(72);
  console.log(`\n${line}`);
  console.log(title);
  console.log(line);
}

async function simulatePushBuild() {
  banner('1) SIMULATE GITHUB_EVENT_NAME=push → deployhub build (real pipeline stages)');
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_EVENT_NAME = 'push';

  const targets = pipelineDeployTargets(config, process.env);
  console.log(`[decision] pipelineDeployTargets => ${JSON.stringify(targets)}`);
  console.log(
    `[expect] only development (trigger=push); production (trigger=manual) must NOT be listed`
  );

  const prevCwd = process.cwd();
  process.chdir(SIM);
  try {
    /** @type {Record<string, unknown>} */
    const state = {};
    // Use real stages but skip detect/install/test/build by disabling them on config
    const stages = buildPipelineStages(config, SIM, state).filter((s) =>
      ['artifact', 'storage', 'deploy'].includes(s.name)
    );
    console.log(`[pipeline] stages to run: ${stages.map((s) => s.name).join(', ')}`);
    const { completed, failure } = await runPipeline(stages, {
      config,
      cwd: SIM,
      state,
    });
    console.log(`[pipeline] completed: ${JSON.stringify(completed)}`);
    console.log(`[pipeline] deployedTargets: ${JSON.stringify(state.deployedTargets)}`);
    if (failure) {
      console.log(`[pipeline] FAILURE: ${failure.message}`);
      throw failure;
    }
    if (!Array.isArray(state.deployedTargets) || state.deployedTargets.includes('production')) {
      throw new Error(
        `REGRESSION: production was deployed on push: ${JSON.stringify(state.deployedTargets)}`
      );
    }
    if (!state.deployedTargets.includes('development')) {
      throw new Error(`development was not deployed: ${JSON.stringify(state.deployedTargets)}`);
    }
    console.log('[ok] push deploy targeted development only');
    return state;
  } finally {
    process.chdir(prevCwd);
  }
}

async function simulateDispatchManual() {
  banner('2) SIMULATE workflow_dispatch → deployhub deploy --env production');
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';

  const pushGate = pipelineDeployTargets(config, process.env);
  console.log(
    `[decision] pipelineDeployTargets on workflow_dispatch => ${JSON.stringify(pushGate)} (build stage skips; explicit deploy handles --env)`
  );

  const { targets, skippedDisabled } = resolveEnvTargets(config, 'production');
  console.log(`[decision] resolveEnvTargets(--env production) => ${JSON.stringify(targets)}`);
  console.log(`[decision] skippedDisabled => ${JSON.stringify(skippedDisabled)}`);
  console.log(
    `[note] trigger is irrelevant for explicit dispatch deploy — production is manual but still deployable`
  );

  const prevCwd = process.cwd();
  process.chdir(SIM);
  try {
    // Artifact layout: artifact/<project>/<date>/v<buildId>
    const projectRoot = path.join(SIM, 'artifact', config.project);
    const dates = (await fs.readdir(projectRoot)).sort().reverse();
    const builds = (await fs.readdir(path.join(projectRoot, dates[0]))).sort().reverse();
    const artifactDir = path.join(projectRoot, dates[0], builds[0]);
    console.log(`[artifact] using ${artifactDir}`);

    const deployed = await deployToAll(config, artifactDir, targets);
    console.log(`[deploy] deployToAll returned: ${JSON.stringify(deployed)}`);
    if (!deployed.includes('production')) {
      throw new Error('production was not deployed on dispatch');
    }
    console.log('[ok] dispatch deployed production (manual trigger bypassed by explicit --env)');
  } finally {
    process.chdir(prevCwd);
  }
}

async function seedSecondBuildsForRollbackHistory() {
  banner('2b) Seed a second build + deploy both envs so each has independent history (≥2 entries)');
  const prevCwd = process.cwd();
  process.chdir(SIM);
  try {
    config.version = '1.0.1';
    const { buildId } = resolveBuildId({ semver: '1.0.1' });
    config.buildId = buildId;
    const result = await createArtifact(config, [], SIM);
    await uploadToAll(config.storage, result.zipPath, config);
    // Deploy both so each env history has another entry
    const deployed = await deployToAll(config, result.artifactDir, [
      'development',
      'production',
    ]);
    console.log(`[seed] second deploy targets: ${JSON.stringify(deployed)} buildId=${buildId}`);
  } finally {
    process.chdir(prevCwd);
  }
}

async function simulateRollbackAll() {
  banner('3) SIMULATE workflow_dispatch rollback --env all (trigger irrelevant)');
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';

  const { targets, skippedDisabled } = resolveEnvTargets(config, 'all');
  console.log(`[decision] resolveEnvTargets(--env all) => ${JSON.stringify(targets)}`);
  console.log(
    `[note] rollback uses resolveEnvTargets (enabled only) — NOT pipelineDeployTargets / trigger`
  );

  const prevCwd = process.cwd();
  process.chdir(SIM);
  try {
    const { results, failures } = await rollbackToVersion(config, undefined, SIM, {
      envNames: targets,
      continueOnError: true,
    });
    console.log('[results] per-env:');
    for (const r of results || []) {
      console.log(
        `  - ${r.envName}: buildId=${r.entry.buildId} semver=${r.entry.semver} remoteKey=${r.entry.remoteKey}`
      );
    }
    console.log('[failures]:', JSON.stringify(failures || [], null, 2));
    const summary = formatRollbackAllSummary(results || [], failures || [], skippedDisabled);
    console.log('');
    console.log(summary);

    const buildIds = (results || []).map((r) => r.envName + ':' + r.entry.buildId);
    console.log(`[history isolation] ${JSON.stringify(buildIds)}`);
    if ((results || []).length < 2) {
      throw new Error('Expected both environments to roll back');
    }
    console.log('[ok] rollback --env all attempted both envs regardless of trigger');
  } finally {
    process.chdir(prevCwd);
  }
}

await fs.ensureDir(LOGS);
await setupProject();
const state1 = await simulatePushBuild();
await simulateDispatchManual();
await seedSecondBuildsForRollbackHistory();
await simulateRollbackAll();

await fs.writeJson(
  path.join(LOGS, 'sim-summary.json'),
  {
    pushDeployedTargets: state1.deployedTargets,
    note: 'Full console captured by shell redirect to logs/e2e-sim.log',
  },
  { spaces: 2 }
);

console.log('\n[done] E2E simulation finished');
