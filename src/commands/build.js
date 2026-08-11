import chalk from 'chalk';
import { loadEnv } from '../core/config.js';
import { loadConfigOrExit } from '../core/load-config-or-exit.js';
import { runPipeline } from '../core/pipeline.js';
import { buildPipelineStages } from '../core/stages.js';

/**
 * @param {import('commander').Command} program
 */
export function registerBuildCommand(program) {
  program
    .command('build')
    .description('Run the full build and deploy pipeline')
    .action(async () => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfigOrExit(cwd);

      /** @type {Record<string, unknown>} */
      const state = {};
      const stages = buildPipelineStages(config, cwd, state);
      const { completed, failure } = await runPipeline(stages, {
        config,
        cwd,
        state,
      });

      if (failure) {
        state.failure = failure.message;
        console.error(chalk.red(`\nBuild failed: ${failure.message}`));
        process.exit(1);
      }

      console.log(chalk.green(`\n✓ Pipeline complete (${completed.length} stages)`));
    });
}

export default { registerBuildCommand };
