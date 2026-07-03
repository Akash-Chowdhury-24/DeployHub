import { downloadFromFirst } from '../storage/index.js';
import { getDeploymentProvider } from '../deployment/index.js';
import { extractArtifact } from '../artifact/engine.js';
import { createLogger } from '../logger/index.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} artifactDir
 * @param {string} envName
 */
async function rollbackTarget(config, artifactDir, envName) {
  const envConfig = config.environments[envName];
  if (!envConfig) {
    throw new Error(`Environment "${envName}" not found in config`);
  }

  const log = createLogger('rollback');
  log.info(`Rolling back ${envName} (${envConfig.type || 'server'})...`);

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

  log.info('Redeploying previous artifact to server targets...');
  for (const envName of targets) {
    await rollbackTarget(config, artifactDir, envName);
  }

  log.success(`Rollback to v${version} complete`);
  return artifactDir;
}

export default { rollbackToVersion };
