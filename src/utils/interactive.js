/**
 * Detect whether the CLI can safely prompt the user.
 * Non-interactive when stdin is not a TTY, or when common CI env vars are set.
 *
 * @param {{ env?: NodeJS.ProcessEnv, stdinIsTTY?: boolean|null }} [options]
 * @returns {boolean}
 */
export function isInteractive(options = {}) {
  const env = options.env || process.env;
  const stdinIsTTY =
    options.stdinIsTTY !== undefined ? options.stdinIsTTY : Boolean(process.stdin.isTTY);

  if (env.CI === 'true' || env.CI === '1') return false;
  if (env.GITHUB_ACTIONS === 'true' || env.GITHUB_ACTIONS === '1') return false;
  if (!stdinIsTTY) return false;
  return true;
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, stdinIsTTY?: boolean|null }} [options]
 * @returns {boolean}
 */
export function isNonInteractive(options = {}) {
  return !isInteractive(options);
}

export default { isInteractive, isNonInteractive };
