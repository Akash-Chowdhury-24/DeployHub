import { isGrandfatheredNginxEnv } from './nginx.js';
import { getEnvSettings } from '../core/environments.js';

/**
 * Sanitize a name for PM2 process naming (same charset as Nginx site names).
 * @param {string} name
 * @returns {string}
 */
export function sanitizePm2AppName(name) {
  return String(name || 'app').replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Whether this env is the grandfathered / single-env case for process naming.
 * Reuses the same grandfather rule as Nginx site filenames.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {boolean}
 */
export function isGrandfatheredPm2Env(config, envName) {
  return isGrandfatheredNginxEnv(config, envName);
}

/**
 * Resolve the PM2 process name for an environment.
 *
 * Same risk class as Nginx site filenames: two backend envs on one host with
 * the same PM2 name will restart/replace each other's process.
 *
 * - Grandfathered / single-env: `settings.appName` || `SSH_APP_NAME` || `project`
 *   (unchanged — existing single-env PM2 processes keep their name).
 * - Additional envs: auto-scope to `{project}-{env}` when the configured name
 *   is missing, equals the project default, or collides with the grandfathered
 *   env's resolved name. An explicitly distinct `appName` / `SSH_APP_NAME` is kept.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string|undefined>} [env] — already secret-overlaid for this env
 * @returns {string}
 */
export function resolvePm2AppName(config, envName, env = process.env) {
  const project = sanitizePm2AppName(config.project || 'app');
  const settings = getEnvSettings(config.environments?.[envName]);
  const configured = (settings.appName || env.SSH_APP_NAME || '').trim();

  if (isGrandfatheredPm2Env(config, envName)) {
    return sanitizePm2AppName(configured || project);
  }

  const grandfather =
    config.unprefixedSecretEnvironment || config.defaultEnvironment || null;
  let grandfatherName = project;
  if (grandfather && config.environments?.[grandfather]) {
    const gfSettings = getEnvSettings(config.environments[grandfather]);
    grandfatherName = sanitizePm2AppName(gfSettings.appName || project);
  }

  const defaults = new Set([project, `${project}-api`, grandfatherName]);
  if (configured && !defaults.has(sanitizePm2AppName(configured))) {
    return sanitizePm2AppName(configured);
  }

  return `${project}-${sanitizePm2AppName(envName)}`;
}

export default {
  sanitizePm2AppName,
  isGrandfatheredPm2Env,
  resolvePm2AppName,
};
