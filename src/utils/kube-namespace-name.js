import { isGrandfatheredNginxEnv } from './nginx.js';
import { getEnvSettings } from '../core/environments.js';
import { sanitizeK8sName } from './kubernetes-manifests.js';

/**
 * Whether this env is the grandfathered / single-env case for namespace naming.
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {boolean}
 */
export function isGrandfatheredKubeNamespaceEnv(config, envName) {
  return isGrandfatheredNginxEnv(config, envName);
}

/**
 * Resolve the Kubernetes namespace for an environment.
 *
 * Deployment *names* stay project-scoped (safe when namespaces differ). Two
 * environments targeting the same cluster with the same namespace WILL collide
 * on Deployment/Service objects — same risk class as PM2/Nginx on one host.
 *
 * - Grandfathered / single-env: settings.kubeNamespace || KUBE_NAMESPACE || project
 *   (unchanged).
 * - Additional envs: if configured namespace is missing or equals the project /
 *   grandfathered namespace, auto-scope to `{project}-{env}`. An explicitly
 *   distinct namespace is kept.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string|undefined>} [env] — already secret-overlaid
 * @returns {string}
 */
export function resolveKubeNamespace(config, envName, env = process.env) {
  const project = sanitizeK8sName(config.project || 'app');
  const settings = getEnvSettings(config.environments?.[envName]);
  const configured = String(
    settings.kubeNamespace || env.KUBE_NAMESPACE || ''
  ).trim();

  if (isGrandfatheredKubeNamespaceEnv(config, envName)) {
    return sanitizeK8sName(configured || project);
  }

  const grandfather =
    config.unprefixedSecretEnvironment || config.defaultEnvironment || null;
  let grandfatherNs = project;
  if (grandfather && config.environments?.[grandfather]) {
    const gfSettings = getEnvSettings(config.environments[grandfather]);
    grandfatherNs = sanitizeK8sName(gfSettings.kubeNamespace || project);
  }

  const defaults = new Set([project, 'default', grandfatherNs]);
  if (configured && !defaults.has(sanitizeK8sName(configured))) {
    return sanitizeK8sName(configured);
  }

  return sanitizeK8sName(`${project}-${envName}`);
}

export default {
  isGrandfatheredKubeNamespaceEnv,
  resolveKubeNamespace,
};
