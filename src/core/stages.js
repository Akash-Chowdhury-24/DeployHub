import { detectFramework } from '../detectors/index.js';
import { getAdapter } from '../adapters/index.js';
import { createArtifact, repackArtifactZip } from '../artifact/engine.js';
import { uploadToAll } from '../storage/index.js';
import { deployToAll } from '../deployment/index.js';
import { sendNotifications } from '../notifications/index.js';
import {
  anyEnvHasResolvableHealthCheckUrl,
  runHealthChecksForEnvs,
} from '../utils/health-check.js';
import {
  anyDockerEnvHasPublishPort,
  runDockerPortPublishChecksForEnvs,
  verifyStageShouldRun,
} from '../utils/docker-port-publish.js';
import { getProjectVersion } from '../utils/version.js';
import { resolveBuildId } from '../utils/build-id.js';
import { ensureDeployScaffold } from '../utils/scaffold.js';
import {
  getEnabledEnvironmentNames,
  resolveDefaultEnvironmentName,
  isEnvEnabled,
  getEnvTrigger,
  configHasBranchMapping,
  getEnvBranch,
  resolvePushBranchName,
} from './environments.js';

/**
 * Environments to deploy during `deployhub build` (pipeline.deploy).
 * - Local: default environment only (promote elsewhere via `deploy --env`).
 * - GitHub Actions push: every enabled env with trigger "push" whose `branch`
 *   matches the push ref. Configs with no `branch` on any environment keep
 *   today's behavior (all push-triggered envs, regardless of ref).
 * - workflow_dispatch: none here (explicit deploy step handles --env).
 *
 * Separate from workflow secret injection: CI may inject secrets for all
 * enabled envs, but only `trigger: "push"` envs are deployed on push.
 *
 * @param {import('./config.js').DeployHubConfig} config
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function pipelineDeployTargets(config, env = process.env) {
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    return [];
  }
  if (env.GITHUB_ACTIONS === 'true' || env.GITHUB_ACTIONS === '1') {
    const pushEnvs = Object.entries(config.environments || {}).filter(
      ([, entry]) => isEnvEnabled(entry) && getEnvTrigger(entry) === 'push'
    );
    if (!configHasBranchMapping(config)) {
      return pushEnvs.map(([name]) => name);
    }
    const branch = resolvePushBranchName(env);
    if (!branch) return [];
    return pushEnvs
      .filter(([, entry]) => (getEnvBranch(entry) || 'main') === branch)
      .map(([name]) => name);
  }
  const def = resolveDefaultEnvironmentName(config);
  if (def && getEnabledEnvironmentNames(config).includes(def)) {
    return [def];
  }
  return getEnabledEnvironmentNames(config).slice(0, 1);
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} cwd
 * @param {Record<string, unknown>} state
 */
export function buildPipelineStages(config, cwd, state) {
  /** @type {import('../core/pipeline.js').PipelineStage[]} */
  const stages = [
    {
      name: 'detect',
      async run(ctx) {
        const detected = await detectFramework(ctx.cwd);
        if (detected) {
          if (!ctx.config.framework) ctx.config.framework = detected.framework;
          if (!ctx.config.projectType && detected.projectType) {
            ctx.config.projectType = detected.projectType;
          }
          if (!ctx.config.language && detected.language) {
            ctx.config.language = detected.language;
          }
          if (ctx.config.buildCommand === undefined && detected.buildCommand !== undefined) {
            ctx.config.buildCommand = detected.buildCommand;
          }
          if (!ctx.config.buildOutput && detected.buildOutput) {
            ctx.config.buildOutput = detected.buildOutput;
          }
          if (!ctx.config.startCommand && detected.startCommand) {
            ctx.config.startCommand = detected.startCommand;
          }
          if (!ctx.config.port && detected.port) {
            ctx.config.port = detected.port;
          }
        }
        // Semver label (package.json) + unique buildId (shared with image tag when DOCKER_IMAGE_TAG unset)
        ctx.config.version = await getProjectVersion(ctx.cwd);
        const { buildId } = resolveBuildId({ semver: ctx.config.version });
        ctx.config.buildId = buildId;
        const scaffold = await ensureDeployScaffold(
          ctx.cwd,
          ctx.config,
          ctx.config.environments || {},
          { silent: false }
        );
        if (scaffold.dockerfile) {
          ctx.config.docker = true;
          if (ctx.config.pipeline) {
            ctx.config.pipeline.docker = true;
          }
        }
        ctx.state.framework = ctx.config.framework;
        ctx.state.projectType = ctx.config.projectType || 'frontend';
      },
    },
    {
      name: 'install',
      async run(ctx) {
        const adapter = getAdapter(ctx.config.framework, ctx.config, ctx.cwd);
        await adapter.install();
      },
    },
    {
      name: 'test',
      enabled: (ctx) => ctx.config.pipeline.test === true,
      async run(ctx) {
        const adapter = getAdapter(ctx.config.framework, ctx.config, ctx.cwd);
        await adapter.test();
      },
    },
    {
      name: 'build',
      async run(ctx) {
        if (ctx.config.projectType === 'both') {
          if (ctx.config.frontend?.buildCommand) {
            const frontendAdapter = getAdapter(
              ctx.config.frontend.framework,
              ctx.config,
              ctx.cwd
            );
            const saved = ctx.config.buildCommand;
            ctx.config.buildCommand = ctx.config.frontend.buildCommand;
            await frontendAdapter.build();
            ctx.config.buildCommand = saved;
          }
          if (ctx.config.backend?.buildCommand) {
            const backendAdapter = getAdapter(
              ctx.config.backend.framework,
              ctx.config,
              ctx.cwd
            );
            const saved = ctx.config.buildCommand;
            ctx.config.buildCommand = ctx.config.backend.buildCommand;
            await backendAdapter.build();
            ctx.config.buildCommand = saved;
          }
          return;
        }

        // Adapters themselves null-guard buildCommand; this stage always
        // invokes build() so interpreted backends can log the skip cleanly.
        const adapter = getAdapter(ctx.config.framework, ctx.config, ctx.cwd);
        await adapter.build();
      },
    },
    {
      name: 'docker',
      enabled: (ctx) =>
        ctx.config.pipeline.docker === true && ctx.config.docker === true,
      async run(ctx) {
        const adapter = getAdapter(ctx.config.framework, ctx.config, ctx.cwd);
        await adapter.docker();
      },
    },
    {
      name: 'artifact',
      enabled: (ctx) => ctx.config.artifact !== false,
      async run(ctx) {
        if (!ctx.config.version) {
          ctx.config.version = await getProjectVersion(ctx.cwd);
        }
        if (!ctx.config.buildId) {
          const { buildId } = resolveBuildId({ semver: ctx.config.version });
          ctx.config.buildId = buildId;
        }
        const result = await createArtifact(
          ctx.config,
          /** @type {string[]} */ (ctx.state.deployedTargets || []),
          ctx.cwd
        );
        ctx.state.artifactDir = result.artifactDir;
        ctx.state.zipPath = result.zipPath;
      },
    },
    {
      name: 'storage',
      enabled: (ctx) => {
        const willDeploy =
          ctx.config.pipeline.deploy === true &&
          getEnabledEnvironmentNames(ctx.config).length > 0;
        if (willDeploy && (!ctx.config.storage || ctx.config.storage.length === 0)) {
          ctx.config.storage = ['local'];
        }
        return (ctx.config.storage?.length || 0) > 0;
      },
      async run(ctx) {
        const zipPath = /** @type {string} */ (ctx.state.zipPath);
        if (!zipPath) throw new Error('No artifact to upload');
        await uploadToAll(ctx.config.storage, zipPath, ctx.config);
        ctx.state.storageCompleted = true;
      },
    },
    {
      name: 'deploy',
      enabled: (ctx) =>
        ctx.config.pipeline.deploy === true &&
        getEnabledEnvironmentNames(ctx.config).length > 0,
      async run(ctx) {
        if (!ctx.state.storageCompleted) {
          throw new Error(
            'Storage upload must complete before deploy. Enable at least one storage provider.'
          );
        }
        const artifactDir = /** @type {string} */ (ctx.state.artifactDir);
        if (!artifactDir) throw new Error('No artifact to deploy');
        const targets = pipelineDeployTargets(ctx.config);
        const deployed = await deployToAll(ctx.config, artifactDir, targets);
        ctx.state.deployedTargets = deployed;

        await repackArtifactZip(artifactDir);
        const zipPath = /** @type {string} */ (ctx.state.zipPath);
        if (zipPath) {
          await uploadToAll(ctx.config.storage, zipPath, ctx.config);
        }
      },
    },
    {
      name: 'verify',
      enabled: (ctx) => {
        if (ctx.config.pipeline.verify !== true) {
          const deployed = /** @type {string[]} */ (ctx.state.deployedTargets || []);
          return anyDockerEnvHasPublishPort(ctx.config, deployed);
        }
        const deployed = /** @type {string[]} */ (ctx.state.deployedTargets || []);
        return verifyStageShouldRun(
          ctx.config,
          deployed,
          anyEnvHasResolvableHealthCheckUrl
        );
      },
      async run(ctx) {
        const deployed = /** @type {string[]} */ (ctx.state.deployedTargets || []);
        const portOutcome = await runDockerPortPublishChecksForEnvs(ctx.config, deployed, {
          requireRunning: true,
        });
        if (portOutcome.failures.length > 0) {
          throw new Error(portOutcome.failures[0].error);
        }
        const { results, failures } = await runHealthChecksForEnvs(ctx.config, deployed);
        if (failures.length > 0) {
          throw new Error(failures[0].error);
        }
        const last = results[results.length - 1];
        if (last) {
          ctx.state.healthCheck = { status: last.status, elapsed: last.elapsed };
        }
      },
    },
    {
      name: 'notify',
      enabled: (ctx) => ctx.config.pipeline.notify === true,
      async run(ctx) {
        const lastDeploy = ctx.state.lastDeployUrl;
        await sendNotifications(ctx.config, {
          success: !ctx.state.failure,
          version: ctx.config.version,
          message: ctx.state.failure
            ? String(ctx.state.failure)
            : 'Build and deploy completed',
          deployUrl: typeof lastDeploy === 'string' ? lastDeploy : ctx.config.healthCheck?.url,
          environment: process.env.DEPLOYHUB_ENV || 'production',
        });
      },
    },
  ];

  return stages;
}

export default { buildPipelineStages };
