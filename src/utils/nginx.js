/**
 * Sanitize a project name for use in Nginx config file paths.
 * @param {string} projectName
 * @returns {string}
 */
export function sanitizeNginxProjectName(projectName) {
  return projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Site filename for Nginx activation. Grandfathered envs keep legacy `{project}` only;
 * additional environments use `{project}-{env}` so same-host multi-env deploys don't clobber.
 *
 * @param {string} projectName
 * @param {string} envName
 * @param {boolean} isGrandfathered
 * @returns {string}
 */
export function sanitizeNginxSiteName(projectName, envName, isGrandfathered) {
  const base = sanitizeNginxProjectName(projectName);
  if (isGrandfathered) {
    // Avoid breaking existing single-env servers that already have sites-available/{project}.
    return base;
  }
  return `${base}-${sanitizeNginxProjectName(envName)}`;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {boolean}
 */
export function isGrandfatheredNginxEnv(config, envName) {
  const envs = config.environments || {};
  if (Object.keys(envs).length <= 1) {
    return true;
  }
  const grandfather =
    config.unprefixedSecretEnvironment || config.defaultEnvironment || null;
  return Boolean(grandfather && envName === grandfather);
}

/**
 * Resolve the Nginx site filename for an environment deploy.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {string}
 */
export function resolveNginxSiteName(config, envName) {
  return sanitizeNginxSiteName(
    config.project || 'app',
    envName,
    isGrandfatheredNginxEnv(config, envName)
  );
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
 * Debian/Ubuntu: sites-available path for this site name.
 * @param {string} siteName — output of resolveNginxSiteName / sanitizeNginxSiteName
 * @returns {string}
 */
export function getNginxSitesAvailablePath(siteName) {
  return `/etc/nginx/sites-available/${siteName}`;
}

/**
 * Debian/Ubuntu: sites-enabled symlink path for this site name.
 * @param {string} siteName
 * @returns {string}
 */
export function getNginxSitesEnabledPath(siteName) {
  return `/etc/nginx/sites-enabled/${siteName}`;
}

/**
 * RHEL/Amazon Linux: conf.d drop-in path for this site name.
 * @param {string} siteName
 * @returns {string}
 */
export function getNginxConfDPath(siteName) {
  return `/etc/nginx/conf.d/${siteName}.conf`;
}

/**
 * @param {string} siteName
 * @returns {string}
 */
export function getNginxSitePath(siteName) {
  return getNginxSitesAvailablePath(siteName);
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
  sanitizeNginxSiteName,
  isGrandfatheredNginxEnv,
  resolveNginxSiteName,
  getNginxSitesAvailablePath,
  getNginxSitesEnabledPath,
  getNginxConfDPath,
  getNginxSitePath,
  formatPasswordlessSudoGuidance,
};
