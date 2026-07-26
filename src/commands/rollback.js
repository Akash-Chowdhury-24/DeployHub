import chalk from 'chalk';
import { loadConfig, loadEnv } from '../core/config.js';
import { rollbackToVersion } from '../utils/rollback/engine.js';
import axios from 'axios';

/**
 * @param {import('commander').Command} program
 */
export function registerRollbackCommand(program) {
  program
    .command('rollback [versionOrBuildId]')
    .description(
      'Rollback to a previous artifact build (omit arg = previous build; use exact buildId if semver is ambiguous)'
    )
    .action(async (versionOrBuildId) => {
      loadEnv();
      const config = await loadConfig();

      try {
        const { entry } = await rollbackToVersion(config, versionOrBuildId);
        if (!versionOrBuildId) {
          console.log(chalk.gray(`Rolled back to previous build: ${entry.buildId}`));
        }

        if (config.healthCheck?.url) {
          try {
            const response = await axios.get(config.healthCheck.url, {
              timeout: (config.healthCheck.timeout || 30) * 1000,
              validateStatus: () => true,
            });
            if (response.status >= 200 && response.status < 400) {
              console.log(chalk.green(`Health check passed: HTTP ${response.status}`));
            } else {
              console.log(chalk.yellow(`Health check returned HTTP ${response.status}`));
            }
          } catch (err) {
            console.log(
              chalk.yellow(
                `Health check failed: ${err instanceof Error ? err.message : String(err)}`
              )
            );
          }
        }

        console.log(chalk.green(`✓ Rolled back to ${entry.buildId}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

export default { registerRollbackCommand };
