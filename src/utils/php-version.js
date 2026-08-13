/**
 * Shared PHP runtime version for CI (setup-php) and Docker base images.
 * Keep Dockerfile FROM tags and GitHub Actions php-version in lockstep.
 */

/** Default PHP for CI / Docker when config does not set phpVersion. */
export const DEFAULT_PHP_VERSION = '8.4';

/**
 * Resolve PHP version for setup-php and `php:{version}-cli-alpine` images.
 * Order: `backend.phpVersion` → top-level `phpVersion` → {@link DEFAULT_PHP_VERSION} (`8.4`).
 * Set either config key in deployhub.config.json to pin a different runtime
 * (e.g. `"phpVersion": "8.3"` or `"backend": { "phpVersion": "8.3" }`).
 *
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string}
 */
export function resolvePhpVersion(config) {
  const fromBackend = config?.backend?.phpVersion;
  if (typeof fromBackend === 'string' && fromBackend.trim()) {
    return fromBackend.trim();
  }
  const fromRoot = config?.phpVersion;
  if (typeof fromRoot === 'string' && fromRoot.trim()) {
    return fromRoot.trim();
  }
  return DEFAULT_PHP_VERSION;
}
