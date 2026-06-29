import ora from 'ora';
import chalk from 'chalk';
import { createLogger } from '../logger/index.js';

/**
 * @typedef {Object} PipelineContext
 * @property {import('./config.js').DeployHubConfig} config
 * @property {string} cwd
 * @property {Record<string, unknown>} state
 */

/**
 * @typedef {Object} PipelineStage
 * @property {string} name
 * @property {function(PipelineContext): Promise<void>} run
 * @property {function(PipelineContext): boolean} [enabled]
 */

/** @type {string[]} */
export const ALL_STAGES = [
  'detect',
  'install',
  'test',
  'build',
  'docker',
  'artifact',
  'storage',
  'deploy',
  'verify',
  'notify',
];

/**
 * @param {PipelineStage[]} stages
 * @param {PipelineContext} context
 */
export async function runPipeline(stages, context) {
  const log = createLogger('pipeline');
  /** @type {string[]} */
  const completed = [];
  /** @type {Error|null} */
  let failure = null;

  for (const stage of stages) {
    if (stage.enabled && !stage.enabled(context)) {
      log.info(`Skipping stage: ${stage.name} (disabled)`);
      continue;
    }

    if (stage.name === 'deploy' && !completed.includes('storage')) {
      throw new Error(
        'Deploy requires storage upload to complete first. Configure at least one storage provider.'
      );
    }

    const spinner = ora({
      text: `Running ${stage.name}...`,
      color: 'cyan',
    }).start();

    try {
      await stage.run(context);
      spinner.succeed(chalk.green(`${stage.name} complete`));
      completed.push(stage.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spinner.fail(chalk.red(`${stage.name} failed: ${message}`));
      failure = err instanceof Error ? err : new Error(message);
      log.error(`Pipeline stopped at stage: ${stage.name}`);
      break;
    }
  }

  return { completed, failure };
}

export default { runPipeline, ALL_STAGES };
