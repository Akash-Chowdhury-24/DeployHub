import chalk from 'chalk';
import axios from 'axios';
import { loadConfig, loadEnv } from '../core/config.js';

/**
 * @param {import('commander').Command} program
 */
export function registerVerifyCommand(program) {
  program
    .command('verify')
    .description('Run health check on configured endpoint')
    .action(async () => {
      loadEnv();
      const config = await loadConfig();
      const url = config.healthCheck?.url;

      if (!url) {
        console.error(chalk.red('No health check URL configured in deployhub.config.json'));
        process.exit(1);
      }

      const timeout = (config.healthCheck.timeout || 30) * 1000;
      const start = Date.now();

      try {
        const response = await axios.get(url, {
          timeout,
          validateStatus: () => true,
        });
        const elapsed = Date.now() - start;
        const ok = response.status >= 200 && response.status < 400;

        if (ok) {
          console.log(
            chalk.green(`✓ Health check passed: HTTP ${response.status} (${elapsed}ms)`)
          );
        } else {
          console.log(
            chalk.red(`✗ Health check failed: HTTP ${response.status} (${elapsed}ms)`)
          );
          process.exit(1);
        }
      } catch (err) {
        const elapsed = Date.now() - start;
        console.error(
          chalk.red(
            `✗ Health check failed: ${err instanceof Error ? err.message : String(err)} (${elapsed}ms)`
          )
        );
        process.exit(1);
      }
    });
}

export default { registerVerifyCommand };
