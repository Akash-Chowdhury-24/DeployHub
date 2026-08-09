import { isGrandfatheredNginxEnv } from './nginx.js';

/**
 * Sanitize a Docker container name (alphanumeric, underscore, hyphen, period).
 * @param {string} name
 * @returns {string}
 */
export function sanitizeDockerContainerName(name) {
  return String(name || 'app')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/^[^a-zA-Z0-9]/, 'a');
}

/**
 * Whether this env is the grandfathered / single-env case for container naming.
 * Reuses the same grandfather rule as Nginx / PM2.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {boolean}
 */
export function isGrandfatheredDockerContainerEnv(config, envName) {
  return isGrandfatheredNginxEnv(config, envName);
}

/**
 * Resolve the Docker container `--name` for an environment.
 *
 * Same risk class as PM2 process names: two docker envs targeting the same
 * daemon with `docker run --name ${project}` will `docker rm -f` each other.
 *
 * - Grandfathered / single-env: `config.project` (unchanged).
 * - Additional envs: `{project}-{env}`.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {string}
 */
export function resolveDockerContainerName(config, envName) {
  const project = sanitizeDockerContainerName(config.project || 'app');
  if (isGrandfatheredDockerContainerEnv(config, envName)) {
    return project;
  }
  return `${project}-${sanitizeDockerContainerName(envName)}`;
}

export default {
  sanitizeDockerContainerName,
  isGrandfatheredDockerContainerEnv,
  resolveDockerContainerName,
};
