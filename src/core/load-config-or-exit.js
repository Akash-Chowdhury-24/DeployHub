import chalk from 'chalk';
import { loadConfig } from './config.js';

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isConfigMissingError(err) {
  return err instanceof Error && /Config not found/i.test(err.message);
}

/**
 * User-facing missing-config message (no stack, no snapshot paths).
 */
export function printMissingConfigError() {
  console.error(chalk.red('✗ No deployhub.config.json found in this directory.'));
  console.error(chalk.red("  Run 'deployhub init' first to set up your project."));
}

/**
 * Load config or print a clean error and exit (never throws to the caller).
 * @param {string} [cwd]
 * @returns {Promise<import('./config.js').DeployHubConfig>}
 */
export async function loadConfigOrExit(cwd = process.cwd()) {
  try {
    return await loadConfig(cwd);
  } catch (err) {
    if (isConfigMissingError(err)) {
      printMissingConfigError();
    } else {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    }
    process.exit(1);
    throw err;
  }
}
