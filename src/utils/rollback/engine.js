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
 * @param {{ buildId: string, semver: string, remoteKey: string }} meta
 */
async function rollbackTarget(config, artifactDir, envName, meta) {
  const envConfig = config.environments[envName];
  if (!envConfig) {
    throw new Error(`Environment "${envName}" not found in config`);
  }

  const log = createLogger('rollback');
  log.info(`Rolling back ${envName} (${envConfig.type || 'server'})...`);

  const provider = getDeploymentProvider(envConfig.type, config, envName);
  await provider.rollback(artifactDir, meta);
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

  const { entries: history } = await loadArtifactHistory(providers, config.project);
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

  // Extract into artifactDir itself so layout matches a normal build artifact:
  // top-level contents (k8s/, dist/, metadata.json, …) alongside artifact.zip.
  log.info('Extracting artifact for rollback...');
  await extractArtifact(artifactDir, artifactDir);

  const targets = config.deploy || [];
  if (targets.length === 0) {
    log.warn('No deployment targets configured');
    return { artifactDir, entry };
  }

  const meta = {
    buildId: entry.buildId,
    semver: entry.semver,
    remoteKey: entry.remoteKey,
  };

  log.info('Redeploying previous artifact to server targets...');
  for (const envName of targets) {
    await rollbackTarget(config, artifactDir, envName, meta);
  }

  log.success(`Rollback to buildId=${entry.buildId} complete`);
  return { artifactDir, entry };
}

export default { rollbackToVersion };
