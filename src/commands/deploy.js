import chalk from 'chalk';
import { loadConfig, loadEnv } from '../core/config.js';
import { resolveEnvTargets } from '../core/environments.js';
import { runPipeline } from '../core/pipeline.js';
import { listLocalArtifacts } from '../artifact/engine.js';
import { deployToAll } from '../deployment/index.js';
import { sendNotifications } from '../notifications/index.js';
import {
  anyEnvHasResolvableHealthCheckUrl,
  runHealthChecksForEnvs,
  formatHealthCheckAllSummary,
} from '../utils/health-check.js';
import { createLogger } from '../logger/index.js';

/**
 * @param {import('commander').Command} program
 */
export function registerDeployCommand(program) {
  program
    .command('deploy')
    .description('Deploy the latest artifact (default environment, or --env)')
    .option(
      '--env <name>',
      'Environment to deploy (name, or "all" for every enabled environment)'
    )
    .action(async (opts) => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      const log = createLogger('deploy');

      let targets;
      let skippedDisabled;
      try {
        ({ targets, skippedDisabled } = resolveEnvTargets(config, opts.env));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      for (const name of skippedDisabled) {
        log.info(`Skipping disabled environment "${name}"`);
      }

      if (targets.length === 0) {
        console.error(chalk.red('No enabled environments to deploy.'));
        process.exit(1);
      }

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
              /** @type {string} */ (ctx.state.artifactDir),
              targets
            );
            ctx.state.deployedTargets = deployed;
          },
        },
        {
          name: 'verify',
          enabled: (ctx) => {
            const deployed = /** @type {string[]} */ (
              ctx.state.deployedTargets || targets
            );
            return anyEnvHasResolvableHealthCheckUrl(ctx.config, deployed);
          },
          async run(ctx) {
            const deployed = /** @type {string[]} */ (
              ctx.state.deployedTargets || targets
            );
            const { results, failures } = await runHealthChecksForEnvs(
              ctx.config,
              deployed
            );

            if (deployed.length > 1 || failures.length > 0) {
              console.log('');
              console.log(formatHealthCheckAllSummary(results, failures));
            } else if (results[0]) {
              console.log(
                chalk.green(
                  `Health check passed (${results[0].envName}): HTTP ${results[0].status} (${results[0].elapsed}ms)`
                )
              );
            }

            if (failures.length > 0) {
              throw new Error(failures[0].error);
            }
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
        console.error(chalk.red(failure.message));
        process.exit(1);
      }

      console.log(chalk.green('✓ Deployment complete'));
    });
}

export default { registerDeployCommand };
