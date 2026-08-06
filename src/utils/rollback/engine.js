import { downloadArtifactEntry, ensureLegacyHistoryCopiedToDefaultEnv, loadEnvArtifactHistory } from '../../storage/index.js';
import { getDeploymentProvider } from '../../deployment/index.js';
import { extractArtifact } from '../../artifact/engine.js';
import { createLogger } from '../../logger/index.js';
import {
  formatAmbiguousRollbackMatches,
  resolveRollbackTarget,
} from '../artifact-history.js';
import {
  getEnabledEnvironmentNames,
  getEnvMethod,
  resolveDefaultEnvironmentName,
} from '../../core/environments.js';
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

  const method = getEnvMethod(envConfig) || 'server';
  const log = createLogger('rollback');
  log.info(`Rolling back ${envName} (${method})...`);

  const provider = getDeploymentProvider(method, config, envName);
  await provider.rollback(artifactDir, meta);
}

/**
 * Map resolveRollbackTarget failures to env-scoped messages.
 * @param {string} envName
 * @param {{ reason: string, message: string, matches?: unknown[] }} resolved
 */
function formatEnvRollbackError(envName, resolved) {
  if (resolved.reason === 'no-previous') {
    return `No previous build found for environment "${envName}" (only one deploy in that environment's history). Deploy again before rolling back.`;
  }
  if (resolved.reason === 'empty') {
    return `No previous build found for environment "${envName}" — that environment has no deploy history yet. Deploy at least once first.`;
  }
  if (resolved.reason === 'ambiguous' && resolved.matches) {
    return `[${envName}] ${resolved.message}\n${formatAmbiguousRollbackMatches(
      /** @type {import('../artifact-history.js').ArtifactHistoryEntry[]} */ (resolved.matches)
    )}`;
  }
  return `[${envName}] ${resolved.message}`;
}

/**
 * Rollback one or more environments. Each target resolves against THAT
 * environment's `envs/{env}/history.json` ONLY — never the project-wide
 * build catalog (`{project}/history.json`) and never another env's history.
 *
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} [versionOrBuildId]
 * @param {string} [cwd]
 * @param {{ envNames?: string[], continueOnError?: boolean }} [options]
 * @returns {Promise<{
 *   artifactDir: string|null,
 *   entry: import('../artifact-history.js').ArtifactHistoryEntry|null,
 *   results: { envName: string, entry: import('../artifact-history.js').ArtifactHistoryEntry, artifactDir: string }[],
 *   failures: { envName: string, error: string }[],
 * }>}
 */
export async function rollbackToVersion(
  config,
  versionOrBuildId,
  cwd = process.cwd(),
  options = {}
) {
  const log = createLogger('rollback');
  const providers = config.storage || [];
  if (providers.length === 0) {
    throw new Error('No storage providers configured — cannot download artifact for rollback');
  }

  const targets = options.envNames || getEnabledEnvironmentNames(config);
  if (targets.length === 0) {
    log.warn('No deployment targets configured');
    return { artifactDir: null, entry: null, results: [], failures: [] };
  }

  const continueOnError = options.continueOnError === true;

  /** @type {{ envName: string, entry: import('../artifact-history.js').ArtifactHistoryEntry, artifactDir: string }[]} */
  const results = [];
  /** @type {{ envName: string, error: string }[]} */
  const failures = [];

  for (const envName of targets) {
    try {
      const defaultEnv = resolveDefaultEnvironmentName(config);
      if (defaultEnv && envName === defaultEnv) {
        await ensureLegacyHistoryCopiedToDefaultEnv(
          providers,
          config.project,
          defaultEnv,
          { legacyHistoryMigrated: config.legacyHistoryMigrated === true }
        );
      }

      // CRITICAL: allowLegacyFallback: false — never read project-wide history.json
      // (build catalog) during rollback. Isolation is absolute per environment.
      const { entries: history } = await loadEnvArtifactHistory(
        providers,
        config.project,
        envName,
        { allowLegacyFallback: false }
      );

      const resolved = resolveRollbackTarget(history, versionOrBuildId);

      if (!resolved.ok) {
        throw new Error(formatEnvRollbackError(envName, resolved));
      }

      const entry = resolved.entry;
      const restoreDir = path.join(cwd, '.deployhub-restore', envName, `v${entry.buildId}`);
      const artifactDir = path.join(restoreDir, 'artifact');

      log.info(
        `Downloading artifact buildId=${entry.buildId} for env "${envName}" (semver=${entry.semver})...`
      );
      await fs.emptyDir(restoreDir);
      await fs.ensureDir(artifactDir);

      const zipPath = path.join(artifactDir, 'artifact.zip');
      await downloadArtifactEntry(providers, config, entry, zipPath);

      log.info(`Extracting artifact for rollback (${envName})...`);
      await extractArtifact(artifactDir, artifactDir);

      const meta = {
        buildId: entry.buildId,
        semver: entry.semver,
        remoteKey: entry.remoteKey,
      };

      await rollbackTarget(config, artifactDir, envName, meta);
      results.push({ envName, entry, artifactDir });
      log.success(`Rollback of ${envName} to buildId=${entry.buildId} complete`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (!continueOnError) {
        throw err instanceof Error ? err : new Error(error);
      }
      failures.push({ envName, error });
      log.error(`Rollback of ${envName} failed: ${error}`);
    }
  }

  const last = results[results.length - 1];
  return {
    artifactDir: last?.artifactDir || null,
    entry: last?.entry || null,
    results,
    failures,
  };
}

/**
 * Format the continue-on-error summary for `--env all`.
 * @param {{ envName: string, entry: { buildId: string } }[]} results
 * @param {{ envName: string, error: string }[]} failures
 * @param {string[]} [skippedDisabled]
 * @returns {string}
 */
export function formatRollbackAllSummary(results, failures, skippedDisabled = []) {
  const lines = ['Rollback summary (--env all):'];
  for (const r of results) {
    lines.push(`  ✓ ${r.envName.padEnd(14)} → rolled back to ${r.entry.buildId}`);
  }
  for (const f of failures) {
    lines.push(`  ✗ ${f.envName.padEnd(14)} → FAILED: ${f.error}`);
  }
  for (const name of skippedDisabled) {
    lines.push(`  – ${name.padEnd(14)} → skipped (disabled)`);
  }
  lines.push('');
  if (failures.length === 0) {
    lines.push(`All ${results.length} environment(s) rolled back successfully.`);
  } else {
    const total = results.length + failures.length;
    lines.push(
      `${failures.length} of ${total} environments failed to roll back. See above for details.`
    );
  }
  return lines.join('\n');
}

export default { rollbackToVersion, formatRollbackAllSummary };
