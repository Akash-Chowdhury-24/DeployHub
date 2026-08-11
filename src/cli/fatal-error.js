import chalk from 'chalk';

/**
 * Format an unexpected CLI error for the user — message only, never a stack
 * or pkg snapshot paths like `C:\snapshot\...` / `/snapshot/...`.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function formatFatalCliError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/[/\\]snapshot[/\\]/i.test(line) && !/^\s*at\s+/.test(line))
    .join(' ')
    .trim() || 'Unknown error';

  return (
    `Unexpected error: ${message}\n` +
    `  If this persists, open an issue with the command you ran.`
  );
}

/**
 * @param {unknown} err
 * @param {(msg: string) => void} [write]
 */
export function reportFatalCliError(err, write = console.error) {
  write(chalk.red(formatFatalCliError(err)));
}

/**
 * Last-resort handlers so unexpected failures never dump a raw Node stack
 * (especially ugly under pkg: `C:\\snapshot\\DeployHub\\...`).
 */
export function installCliFatalHandlers() {
  process.on('uncaughtException', (err) => {
    reportFatalCliError(err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    reportFatalCliError(reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
  });
}
