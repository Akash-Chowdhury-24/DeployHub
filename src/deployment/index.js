import { createSshProvider } from './providers/ssh.js';
import { createDockerProvider } from './providers/docker.js';
import { createEc2Provider } from './providers/ec2.js';
import { createAzureVmProvider } from './providers/azure-vm.js';
import { createGcpVmProvider } from './providers/gcp-vm.js';
import { createKubernetesProvider } from './providers/kubernetes.js';
import { createLogger } from '../logger/index.js';
import {
  getEnabledEnvironmentNames,
  getEnvMethod,
  getEnvSettings,
} from '../core/environments.js';
import { assertHooksAllowed } from './hooks.js';
import { applyEnvSecretOverlay } from './deployment-env.js';
import { recordEnvDeployment } from '../storage/index.js';
import { buildArtifactRemoteKey } from '../utils/build-id.js';
import path from 'path';
import fs from 'fs-extra';

/** @type {Record<string, Function>} */
const PROVIDER_FACTORIES = {
  ssh: createSshProvider,
  docker: createDockerProvider,
  ec2: createEc2Provider,
  'azure-vm': createAzureVmProvider,
  'gcp-vm': createGcpVmProvider,
  kubernetes: createKubernetesProvider,
};

/**
 * @param {string} type
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function getDeploymentProvider(type, config, envName, env = process.env) {
  const environment = config.environments[envName];
  if (!environment) {
    throw new Error(`Environment "${envName}" not found in config`);
  }

  const providerType = type || getEnvMethod(environment);
  const factory = PROVIDER_FACTORIES[providerType];
  if (!factory) {
    throw new Error(`Unknown deployment provider: ${providerType}`);
  }
  const resolvedEnv = applyEnvSecretOverlay(envName, config, env);
  return factory(config, envName, resolvedEnv);
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} artifactDir
 * @param {string[]} [envNames]
 */
export async function deployToAll(config, artifactDir, envNames) {
  const log = createLogger('deploy');
  const targets = envNames || getEnabledEnvironmentNames(config);

  if (targets.length === 0) {
    log.warn('No deployment targets configured, skipping');
    return [];
  }

  const buildId =
    config.buildId ||
    (await fs.readJson(path.join(artifactDir, 'metadata.json')).catch(() => ({}))).buildId;
  if (buildId) {
    config.buildId = String(buildId);
  }

  const zipCandidates = [
    path.join(artifactDir, 'artifact.zip'),
    path.join(artifactDir, `${config.project || 'artifact'}.zip`),
  ];
  let zipPath = zipCandidates.find((p) => fs.existsSync(p)) || null;

  const deployed = [];
  for (const envName of targets) {
    const envConfig = config.environments[envName];
    if (!envConfig) {
      throw new Error(`Environment "${envName}" not found in config`);
    }

    const method = getEnvMethod(envConfig);
    assertHooksAllowed(method, getEnvSettings(envConfig), envName);
    const provider = getDeploymentProvider(method, config, envName);
    log.info(`Deploying to ${envName} (${method})...`);
    await provider.deploy(artifactDir);
    deployed.push(envName);
    log.success(`Deployed to ${envName}`);

    // Per-env deploy history (isolated). Shared builds/{buildId} is unchanged.
    if (config.buildId && (config.storage || []).length > 0) {
      try {
        if (!zipPath || !(await fs.pathExists(zipPath))) {
          const files = await fs.readdir(artifactDir).catch(() => []);
          const found = files.find((f) => f.endsWith('.zip'));
          zipPath = found ? path.join(artifactDir, found) : zipPath;
        }
        await recordEnvDeployment(
          config.storage,
          zipPath || '',
          config,
          envName,
          {
            buildId: String(config.buildId),
            semver: config.version,
            remoteKey: buildArtifactRemoteKey(config.project, String(config.buildId)),
          }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Deploy to ${envName} succeeded but recording env history failed: ${msg}`
        );
      }
    }
  }

  return deployed;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} artifactDir
 * @param {string[]} [envNames]
 * @param {{ buildId?: string, semver?: string, remoteKey?: string }} [meta]
 */
export async function rollbackAll(config, artifactDir, envNames, meta) {
  const targets = envNames || getEnabledEnvironmentNames(config);
  for (const envName of targets) {
    const envConfig = config.environments[envName];
    const method = getEnvMethod(envConfig);
    assertHooksAllowed(method, getEnvSettings(envConfig), envName);
    const provider = getDeploymentProvider(method, config, envName);
    await provider.rollback(artifactDir, meta);
  }
}

export default { getDeploymentProvider, deployToAll, rollbackAll };
