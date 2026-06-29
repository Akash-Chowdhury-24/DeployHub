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
 * @param {string} projectName
 * @returns {string}
 */
export function getNginxSitePath(projectName) {
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `/etc/nginx/sites-available/${safeName}`;
}

export default { generateNginxConfig, getNginxSitePath };
