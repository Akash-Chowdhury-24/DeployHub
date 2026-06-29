import chalk from 'chalk';
import { loadConfig, loadEnv } from '../core/config.js';
import { rollbackToVersion } from '../rollback/engine.js';
import axios from 'axios';

/**
 * @param {import('commander').Command} program
 */
export function registerRollbackCommand(program) {
  program
    .command('rollback [version]')
    .description('Rollback to a previous artifact version')
    .action(async (version) => {
      loadEnv();
      const config = await loadConfig();

      if (!version) {
        const { listLocalArtifacts } = await import('../artifact/engine.js');
        const artifacts = await listLocalArtifacts();
        if (artifacts.length < 2) {
          console.error(chalk.red('No previous version available for rollback'));
          process.exit(1);
        }
        version = artifacts[1].version;
        console.log(chalk.gray(`Rolling back to previous version: v${version}`));
      }

      await rollbackToVersion(config, version);

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
          console.log(chalk.yellow(`Health check failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      console.log(chalk.green(`✓ Rolled back to v${version}`));
    });
}

export default { registerRollbackCommand };
