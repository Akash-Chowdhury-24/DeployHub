import { createSshProvider } from './providers/ssh.js';
import { createDockerProvider } from './providers/docker.js';
import { createEc2Provider } from './providers/ec2.js';
import { createAzureVmProvider } from './providers/azure-vm.js';
import { createGcpVmProvider } from './providers/gcp-vm.js';
import { createKubernetesProvider } from './providers/kubernetes.js';
import { createLogger } from '../logger/index.js';

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

  const providerType = type || environment.type;
  const factory = PROVIDER_FACTORIES[providerType];
  if (!factory) {
    throw new Error(`Unknown deployment provider: ${providerType}`);
  }
  return factory(config, envName, env);
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} artifactDir
 * @param {string[]} [envNames]
 */
export async function deployToAll(config, artifactDir, envNames) {
  const log = createLogger('deploy');
  const targets = envNames || config.deploy || [];

  if (targets.length === 0) {
    log.warn('No deployment targets configured, skipping');
    return [];
  }

  const deployed = [];
  for (const envName of targets) {
    const envConfig = config.environments[envName];
    if (!envConfig) {
      throw new Error(`Environment "${envName}" not found in config`);
    }

    const provider = getDeploymentProvider(envConfig.type, config, envName);
    log.info(`Deploying to ${envName} (${envConfig.type})...`);
    await provider.deploy(artifactDir);
    deployed.push(envName);
    log.success(`Deployed to ${envName}`);
  }

  return deployed;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} artifactDir
 * @param {string[]} [envNames]
 */
export async function rollbackAll(config, artifactDir, envNames) {
  const targets = envNames || config.deploy || [];
  for (const envName of targets) {
    const envConfig = config.environments[envName];
    const provider = getDeploymentProvider(envConfig.type, config, envName);
    await provider.rollback(artifactDir);
  }
}

export default { getDeploymentProvider, deployToAll, rollbackAll };
