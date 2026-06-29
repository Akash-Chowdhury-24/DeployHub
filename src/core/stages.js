import { detectFramework } from '../detectors/index.js';
import { getAdapter } from '../adapters/index.js';
import { createArtifact, repackArtifactZip } from '../artifact/engine.js';
import { uploadToAll } from '../storage/index.js';
import { deployToAll } from '../deployment/index.js';
import { sendNotifications } from '../notifications/index.js';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { getProjectVersion } from '../utils/version.js';

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
        ctx.config.version = await getProjectVersion(ctx.cwd);
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
          ctx.config.pipeline.deploy === true && (ctx.config.deploy?.length || 0) > 0;
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
        ctx.config.pipeline.deploy === true && (ctx.config.deploy?.length || 0) > 0,
      async run(ctx) {
        if (!ctx.state.storageCompleted) {
          throw new Error(
            'Storage upload must complete before deploy. Enable at least one storage provider.'
          );
        }
        const artifactDir = /** @type {string} */ (ctx.state.artifactDir);
        if (!artifactDir) throw new Error('No artifact to deploy');
        const deployed = await deployToAll(ctx.config, artifactDir);
        ctx.state.deployedTargets = deployed;

        const deploymentPath = path.join(artifactDir, 'deployment.json');
        if (await fs.pathExists(deploymentPath)) {
          const data = await fs.readJson(deploymentPath);
          const last = data.lastDeployment;
          if (last?.deployUrl || last?.deploymentUrl) {
            ctx.state.lastDeployUrl = last.deployUrl || last.deploymentUrl;
          }
        }

        await repackArtifactZip(artifactDir);
        const zipPath = /** @type {string} */ (ctx.state.zipPath);
        if (zipPath) {
          await uploadToAll(ctx.config.storage, zipPath, ctx.config);
        }
      },
    },
    {
      name: 'verify',
      enabled: (ctx) =>
        ctx.config.pipeline.verify === true && !!ctx.config.healthCheck?.url,
      async run(ctx) {
        const url = ctx.config.healthCheck.url;
        const timeout = (ctx.config.healthCheck.timeout || 30) * 1000;
        const start = Date.now();
        const response = await axios.get(url, {
          timeout,
          validateStatus: () => true,
        });
        const elapsed = Date.now() - start;
        if (response.status < 200 || response.status >= 400) {
          throw new Error(
            `Health check failed: HTTP ${response.status} (${elapsed}ms)`
          );
        }
        ctx.state.healthCheck = { status: response.status, elapsed };
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
