import chalk from 'chalk';
import { loadConfig, loadEnv } from '../core/config.js';
import { runPipeline } from '../core/pipeline.js';
import { listLocalArtifacts } from '../artifact/engine.js';
import { deployToAll } from '../deployment/index.js';
import { sendNotifications } from '../notifications/index.js';
import axios from 'axios';

/**
 * @param {import('commander').Command} program
 */
export function registerDeployCommand(program) {
  program
    .command('deploy')
    .description('Deploy the latest artifact')
    .action(async () => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfig(cwd);

      const artifacts = await listLocalArtifacts(cwd);
      if (artifacts.length === 0) {
        console.error(chalk.red('No artifacts found. Run deployhub build first.'));
        process.exit(1);
      }

      const latest = artifacts[0];
      /** @type {Record<string, unknown>} */
      const state = { artifactDir: latest.path };

      const stages = [
        {
          name: 'deploy',
          async run(ctx) {
            const deployed = await deployToAll(
              ctx.config,
              /** @type {string} */ (ctx.state.artifactDir)
            );
            ctx.state.deployedTargets = deployed;
          },
        },
        {
          name: 'verify',
          enabled: (ctx) => !!ctx.config.healthCheck?.url,
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
              throw new Error(`Health check failed: HTTP ${response.status}`);
            }
            console.log(chalk.green(`Health check passed: ${response.status} (${elapsed}ms)`));
          },
        },
        {
          name: 'notify',
          enabled: (ctx) => ctx.config.pipeline.notify === true,
          async run(ctx) {
            await sendNotifications(ctx.config, {
              success: true,
              version: latest.version,
            });
          },
        },
      ];

      const { failure } = await runPipeline(stages, { config, cwd, state });
      if (failure) {
        console.error(chalk.red(`Deploy failed: ${failure.message}`));
        process.exit(1);
      }

      console.log(chalk.green('✓ Deployment complete'));
    });
}

export default { registerDeployCommand };
