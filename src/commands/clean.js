import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { loadConfig } from '../core/config.js';
import { listLocalArtifacts } from '../artifact/engine.js';

/**
 * @param {import('commander').Command} program
 */
export function registerCleanCommand(program) {
  program
    .command('clean')
    .description('Delete old local artifacts beyond retention count')
    .option('-k, --keep <count>', 'Number of artifacts to keep', '')
    .action(async (options) => {
      const cwd = process.cwd();
      let retention = 10;

      try {
        const config = await loadConfig(cwd);
        retention = config.artifactRetention || 10;
      } catch {
        // use default
      }

      if (options.keep) {
        retention = parseInt(options.keep, 10);
      }

      const artifacts = await listLocalArtifacts(cwd);
      if (artifacts.length <= retention) {
        console.log(
          chalk.gray(`Nothing to clean (${artifacts.length} artifacts, keeping ${retention})`)
        );
        return;
      }

      const toRemove = artifacts.slice(retention);
      for (const artifact of toRemove) {
        await fs.remove(artifact.path);
        console.log(chalk.gray(`Removed ${artifact.path}`));
      }

      console.log(
        chalk.green(`✓ Cleaned ${toRemove.length} old artifact(s), kept ${retention}`)
      );
    });
}

export default { registerCleanCommand };
