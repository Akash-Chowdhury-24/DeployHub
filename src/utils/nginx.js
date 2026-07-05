/**
 * Sanitize a project name for use in Nginx config file paths.
 * @param {string} projectName
 * @returns {string}
 */
export function sanitizeNginxProjectName(projectName) {
  return projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Generate nginx server block config for SPA frontend deployments.
 *
 * @param {string} projectName
 * @param {string} deployPath - Absolute deploy path on the server
 * @param {string} [buildOutput='dist']
 * @returns {string}
 */
export function generateNginxConfig(projectName, deployPath, buildOutput = 'dist') {
  const root = `${deployPath.replace(/\/$/, '')}/${buildOutput}`;

  return `server {
    listen 80;
    server_name _;
    root ${root};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`;
}

/**
 * Debian/Ubuntu: sites-available path for this project.
 * @param {string} projectName
 * @returns {string}
 */
export function getNginxSitesAvailablePath(projectName) {
  return `/etc/nginx/sites-available/${sanitizeNginxProjectName(projectName)}`;
}

/**
 * Debian/Ubuntu: sites-enabled symlink path for this project.
 * @param {string} projectName
 * @returns {string}
 */
export function getNginxSitesEnabledPath(projectName) {
  return `/etc/nginx/sites-enabled/${sanitizeNginxProjectName(projectName)}`;
}

/**
 * RHEL/Amazon Linux: conf.d drop-in path for this project.
 * @param {string} projectName
 * @returns {string}
 */
export function getNginxConfDPath(projectName) {
  return `/etc/nginx/conf.d/${sanitizeNginxProjectName(projectName)}.conf`;
}

/**
 * @param {string} projectName
 * @returns {string}
 */
export function getNginxSitePath(projectName) {
  return getNginxSitesAvailablePath(projectName);
}

/**
 * @param {string} sshUser
 * @returns {string}
 */
export function formatPasswordlessSudoGuidance(sshUser) {
  return (
    `Passwordless sudo required to activate Nginx config during deploy.\n` +
    `  On your server, run sudo visudo and add a line like:\n` +
    `    ${sshUser} ALL=(ALL) NOPASSWD: /usr/sbin/nginx, /bin/cp, /usr/bin/cp, /bin/systemctl, /usr/bin/systemctl\n` +
    `  (replace ${sshUser} with your SSH_USER)\n` +
    `  Security: this grants broad cp/systemctl access — see README one-time server setup for a production-hardening note.`
  );
}

export default {
  generateNginxConfig,
  sanitizeNginxProjectName,
  getNginxSitesAvailablePath,
  getNginxSitesEnabledPath,
  getNginxConfDPath,
  getNginxSitePath,
  formatPasswordlessSudoGuidance,
};
