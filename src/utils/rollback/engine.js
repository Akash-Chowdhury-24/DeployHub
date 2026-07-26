import { downloadArtifactEntry, loadArtifactHistory } from '../../storage/index.js';
import { getDeploymentProvider } from '../../deployment/index.js';
import { extractArtifact } from '../../artifact/engine.js';
import { createLogger } from '../../logger/index.js';
import {
  formatAmbiguousRollbackMatches,
  resolveRollbackTarget,
} from '../artifact-history.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
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
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} [versionOrBuildId]
 * @param {string} [cwd]
 */
export async function rollbackToVersion(config, versionOrBuildId, cwd = process.cwd()) {
  const log = createLogger('rollback');
  const providers = config.storage || [];
  if (providers.length === 0) {
    throw new Error('No storage providers configured — cannot download artifact for rollback');
  }

  const history = await loadArtifactHistory(providers, config.project);
  const resolved = resolveRollbackTarget(history, versionOrBuildId);

  if (!resolved.ok) {
    if (resolved.reason === 'ambiguous' && resolved.matches) {
      throw new Error(
        `${resolved.message}\n${formatAmbiguousRollbackMatches(resolved.matches)}`
      );
    }
    throw new Error(resolved.message);
  }

  const entry = resolved.entry;
  const restoreDir = path.join(cwd, '.deployhub-restore', `v${entry.buildId}`);
  const artifactDir = path.join(restoreDir, 'artifact');

  log.info(`Downloading artifact buildId=${entry.buildId} (semver=${entry.semver})...`);
  await fs.emptyDir(restoreDir);
  await fs.ensureDir(artifactDir);

  const zipPath = path.join(artifactDir, 'artifact.zip');
  await downloadArtifactEntry(providers, config, entry, zipPath);

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
    return { artifactDir, entry };
  }

  log.info('Redeploying previous artifact to server targets...');
  for (const envName of targets) {
    await rollbackTarget(config, artifactDir, envName);
  }

  log.success(`Rollback to buildId=${entry.buildId} complete`);
  return { artifactDir, entry };
}

export default { rollbackToVersion };
