/**
 * Wrap a value for safe interpolation into a POSIX shell command string.
 * Uses single quotes; embedded single quotes are escaped as '\''.
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  if (value == null) return "''";
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} command
 * @param {number|null|undefined} code
 * @param {string} [stderr]
 * @param {string} [stdout]
 * @returns {string}
 */
export function formatRemoteCommandFailure(command, code, stderr, stdout) {
  const cmdName = command.trim().split(/\s+/)[0] || 'command';
  const detail = (stderr || stdout || '').trim();
  return `Deploy failed: ${cmdName} exited with code ${code}${detail ? `: ${detail}` : ''}`;
}

/**
 * Remote shell command that verifies write access to a deploy directory.
 * @param {string} deployPath
 * @returns {string}
 */
export function buildDeployPathWriteTestCommand(deployPath) {
  const dir = shellQuote(deployPath);
  const testFile = shellQuote(`${deployPath}/.deployhub-write-test`);
  return `mkdir -p ${dir} && touch ${testFile} && rm -f ${testFile}`;
}

/**
 * @param {string} deployPath
 * @param {string} sshUser
 * @param {string} [errorDetail]
 * @returns {string}
 */
export function formatDeployPathWriteFailure(deployPath, sshUser, errorDetail) {
  const reason = errorDetail ? ` (${errorDetail.trim()})` : '';
  const quotedPath = shellQuote(deployPath);
  return (
    `Cannot write to ${deployPath} on the server${reason}.\n` +
    `  Run this on your server first:\n` +
    `    sudo mkdir -p ${quotedPath}\n` +
    `    sudo chown ${sshUser}:${sshUser} ${quotedPath}\n` +
    `  (replace ${sshUser} with your actual SSH_USER if different)`
  );
}

/**
 * @param {string} name
 * @returns {string}
 */
export function toKebabCase(name) {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .toLowerCase();
}
