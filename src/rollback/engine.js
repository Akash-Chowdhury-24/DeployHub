import { downloadFromFirst } from '../storage/index.js';
import { createPlatformProvider } from '../deployment/providers/platforms/index.js';
import { extractArtifact } from '../artifact/engine.js';
import { createLogger } from '../logger/index.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} artifactDir
 * @param {string} envName
 */
async function rollbackPlatformTarget(config, artifactDir, envName) {
  const envConfig = config.environments[envName];
  if (!envConfig) {
    throw new Error(`Environment "${envName}" not found in config`);
  }

  const deploymentPath = path.join(artifactDir, 'deployment.json');
  if (await fs.pathExists(deploymentPath)) {
    const data = await fs.readJson(deploymentPath);
    const deployments = data.deployments || data.platformDeployments || [];
    const record = deployments.find((d) => d.environmentName === envName) || data.lastDeployment;
    if (record?.platform) {
      const log = createLogger('rollback');
      log.info(
        `Rolling back ${envName} on ${record.platform} (deploy ${record.deployId || record.deploymentId || 'previous'})...`
      );
    }
  }

  if (envConfig.deploymentType === 'platform' || envConfig.frontendDeploymentType === 'platform') {
    const platform = envConfig.platform;
    if (!platform) {
      throw new Error(`No platform configured for environment "${envName}"`);
    }
    const provider = createPlatformProvider(platform, config, envName);
    await provider.rollback(artifactDir);
    return;
  }

  if (
    envConfig.frontendDeploymentType === 'platform' &&
    (envConfig.backendDeploymentType === 'server' || envConfig.type)
  ) {
    const platformProvider = createPlatformProvider(envConfig.platform, config, envName);
    await platformProvider.rollback(artifactDir);
    const { getDeploymentProvider } = await import('../deployment/index.js');
    const serverProvider = getDeploymentProvider(envConfig.type, config, envName);
    await serverProvider.rollback(artifactDir);
    return;
  }

  const { getDeploymentProvider } = await import('../deployment/index.js');
  const provider = getDeploymentProvider(envConfig.type, config, envName);
  await provider.rollback(artifactDir);
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} version
 * @param {string} [cwd]
 */
export async function rollbackToVersion(config, version, cwd = process.cwd()) {
  const log = createLogger('rollback');
  const remoteKey = `${config.project}/v${version}/artifact.zip`;
  const restoreDir = path.join(cwd, '.deployhub-restore', `v${version}`);
  const artifactDir = path.join(restoreDir, 'artifact');

  log.info(`Downloading artifact v${version}...`);
  await fs.emptyDir(restoreDir);
  await fs.ensureDir(artifactDir);

  const zipPath = path.join(artifactDir, 'artifact.zip');
  await downloadFromFirst(config.storage, remoteKey, zipPath);

  log.info('Extracting artifact for rollback...');
  const extractedDir = path.join(artifactDir, '_extracted');
  await fs.emptyDir(extractedDir);
  await extractArtifact(artifactDir, extractedDir);

  const extractedDeployment = path.join(extractedDir, 'deployment.json');
  if (await fs.pathExists(extractedDeployment)) {
    await fs.copy(extractedDeployment, path.join(artifactDir, 'deployment.json'));
  }

  const targets = config.deploy || [];
  if (targets.length === 0) {
    log.warn('No deployment targets configured');
    return artifactDir;
  }

  log.info('Executing platform-specific rollback from deployment.json...');
  for (const envName of targets) {
    await rollbackPlatformTarget(config, artifactDir, envName);
  }

  log.success(`Rollback to v${version} complete`);
  return artifactDir;
}

export default { rollbackToVersion };
