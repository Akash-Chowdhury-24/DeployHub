import chalk from 'chalk';

/**
 * @param {string} stage
 * @returns {string}
 */
function timestamp() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * @param {string} stage
 * @param {string} message
 * @param {'info'|'success'|'warn'|'error'} level
 */
function log(stage, message, level = 'info') {
  const prefix = chalk.gray(`[${timestamp()}]`) + chalk.cyan(` [${stage}]`);
  const colors = {
    info: chalk.white,
    success: chalk.green,
    warn: chalk.yellow,
    error: chalk.red,
  };
  console.log(`${prefix} ${colors[level](message)}`);
}

/**
 * @param {string} stage
 * @returns {{ info: Function, success: Function, warn: Function, error: Function }}
 */
export function createLogger(stage) {
  return {
    info: (msg) => log(stage, msg, 'info'),
    success: (msg) => log(stage, msg, 'success'),
    warn: (msg) => log(stage, msg, 'warn'),
    error: (msg) => log(stage, msg, 'error'),
  };
}

export default { createLogger };
