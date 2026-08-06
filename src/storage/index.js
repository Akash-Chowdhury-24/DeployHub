import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger/index.js';
import { createAwsProvider } from './providers/aws.js';
import { createLocalProvider } from './providers/local.js';
import { createAzureProvider } from './providers/azure.js';
import { createGcpProvider } from './providers/gcp.js';
import { createGdriveProvider } from './providers/gdrive.js';
import { createDropboxProvider } from './providers/dropbox.js';
import { createFtpProvider } from './providers/ftp.js';
import {
  buildArtifactRemoteKey,
  envHistoryRemoteKey,
  envLatestArtifactRemoteKey,
  historyRemoteKey,
  latestArtifactRemoteKey,
  legacyArtifactRemoteKey,
  resolveBuildId,
} from '../utils/build-id.js';
import {
  parseArtifactHistory,
  prependHistoryEntry,
} from '../utils/artifact-history.js';
import { summarizeStorageError } from './storage-errors.js';

/**
 * Unique temp path — never Date.now() alone (collides across concurrent
 * processes / Jest workers in the same millisecond and corrupts history reads).
 * @param {string} prefix
 * @param {string} [ext]
 */
function uniqueTmpPath(prefix, ext = '.json') {
  return path.join(os.tmpdir(), `${prefix}-${randomUUID()}${ext}`);
}

/** @type {Record<string, (env?: Record<string, string>) => ReturnType<typeof createAwsProvider>>} */
const PROVIDER_FACTORIES = {
  aws: createAwsProvider,
  local: createLocalProvider,
  azure: createAzureProvider,
  gcp: createGcpProvider,
  gdrive: createGdriveProvider,
  dropbox: createDropboxProvider,
  ftp: createFtpProvider,
};

/**
 * @param {string} name
 * @param {Record<string, string>} [env]
 */
export function getStorageProvider(name, env = process.env) {
  const factory = PROVIDER_FACTORIES[name];
  if (!factory) {
    throw new Error(`Unknown storage provider: ${name}`);
  }
  return factory(env);
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 */
function ensureBuildIdentity(config) {
  if (!config.version) {
    config.version = '0.0.0';
  }
  if (!config.buildId) {
    const { buildId } = resolveBuildId({ semver: config.version });
    config.buildId = buildId;
  }
}

/**
 * Read history.json from the first provider that has it.
 * Missing keys across all providers → { entries: [], source: null }.
 * Auth / network / permission failures → thrown with a concise actionable message
 * (not silently treated as "no history").
 *
 * @param {string[]} providers
 * @param {string} project
 * @returns {Promise<{
 *   entries: import('../utils/artifact-history.js').ArtifactHistoryEntry[],
 *   source: string|null,
 * }>}
 */
export async function loadArtifactHistory(providers, project) {
  if (!providers || providers.length === 0) {
    return { entries: [], source: null };
  }

  const key = historyRemoteKey(project);
  const tmp = uniqueTmpPath('deployhub-history');

  try {
    for (const name of providers) {
      try {
        const provider = getStorageProvider(name);
        const exists = await provider.verify(key);
        if (!exists) continue;

        await provider.download(key, tmp);
        const raw = await fs.readFile(tmp, 'utf8');
        return {
          entries: parseArtifactHistory(raw),
          source: name,
        };
      } catch (err) {
        const reason = summarizeStorageError(err);
        throw new Error(
          `Could not check remote history via ${name}: ${reason} — ` +
            'verify your storage credentials and configuration are correct.'
        );
      }
    }
  } finally {
    await fs.remove(tmp).catch(() => {});
  }

  return { entries: [], source: null };
}

/**
 * @param {ReturnType<typeof getStorageProvider>} provider
 * @param {string} project
 * @param {import('../utils/artifact-history.js').ArtifactHistoryEntry[]} history
 */
async function writeArtifactHistory(provider, project, history) {
  const key = historyRemoteKey(project);
  const tmp = uniqueTmpPath('deployhub-history-write');
  await fs.writeJson(tmp, history, { spaces: 2 });
  try {
    await provider.upload(tmp, key);
  } finally {
    await fs.remove(tmp).catch(() => {});
  }
}

/**
 * @param {ReturnType<typeof getStorageProvider>} provider
 * @param {string} project
 * @param {string} envName
 * @param {import('../utils/artifact-history.js').ArtifactHistoryEntry[]} history
 */
async function writeEnvArtifactHistory(provider, project, envName, history) {
  const key = envHistoryRemoteKey(project, envName);
  const tmp = uniqueTmpPath('deployhub-env-hist-write');
  await fs.writeJson(tmp, history, { spaces: 2 });
  try {
    await provider.upload(tmp, key);
  } finally {
    await fs.remove(tmp).catch(() => {});
  }
}

function legacyHistoryCopiedMarkerKey(project) {
  return `${project}/.legacy-env-history-copied`;
}

/**
 * Record that legacy history migration was handled (copy attempted or not needed).
 * Prevents later rollback from copying the build catalog into the default env.
 *
 * @param {string[]} providers
 * @param {string} project
 */
async function markLegacyHistoryMigrationHandled(providers, project) {
  if (!providers?.length || !project) return;
  for (const name of providers) {
    const provider = getStorageProvider(name);
    if (await provider.verify(legacyHistoryCopiedMarkerKey(project))) {
      return;
    }
    const markerTmp = uniqueTmpPath('deployhub-legacy-copied', '.txt');
    await fs.writeFile(markerTmp, '1');
    try {
      await provider.upload(markerTmp, legacyHistoryCopiedMarkerKey(project));
    } finally {
      await fs.remove(markerTmp).catch(() => {});
    }
  }
}

/**
 * One-time copy of legacy `{project}/history.json` into the default environment's
 * `envs/{default}/history.json`. Separate from `recordEnvDeployment` (which never
 * seeds from the project build catalog).
 *
 * Guard scope (judgment call — see comment in source):
 * Only skips when the default env's own history key already exists, or when migration
 * was already handled (storage marker / config.legacyHistoryMigrated). We do NOT skip
 * just because a sibling env (e.g. testing) has history — that would lock default out
 * of recovering real pre-multi-env deploy history after shape migration.
 *
 * @param {string[]} providers
 * @param {string} project
 * @param {string} defaultEnvironment
 * @param {{ legacyHistoryMigrated?: boolean }} [options]
 * @returns {Promise<boolean>} true when a copy was written
 */
export async function ensureLegacyHistoryCopiedToDefaultEnv(
  providers,
  project,
  defaultEnvironment,
  options = {}
) {
  if (!providers?.length || !project || !defaultEnvironment) return false;
  if (options.legacyHistoryMigrated === true) return false;

  for (const name of providers) {
    const provider = getStorageProvider(name);
    if (await provider.verify(legacyHistoryCopiedMarkerKey(project))) {
      return false;
    }
  }

  const envKey = envHistoryRemoteKey(project, defaultEnvironment);
  for (const name of providers) {
    const provider = getStorageProvider(name);
    if (await provider.verify(envKey)) {
      return false;
    }
  }

  const legacy = await loadArtifactHistory(providers, project);
  if (legacy.entries.length === 0) {
    await markLegacyHistoryMigrationHandled(providers, project);
    return false;
  }

  const log = createLogger('storage');
  log.info(
    `Migrating legacy deploy history into env "${defaultEnvironment}" (${legacy.entries.length} entries)...`
  );

  for (const name of providers) {
    const provider = getStorageProvider(name);
    await writeEnvArtifactHistory(provider, project, defaultEnvironment, legacy.entries);
  }
  await markLegacyHistoryMigrationHandled(providers, project);
  return true;
}

/**
 * Load per-environment deploy history.
 * Legacy project-wide `{project}/history.json` is NOT merged here during rollback
 * (use `ensureLegacyHistoryCopiedToDefaultEnv` first). Read-only legacy fallback for
 * list/doctor when `allowLegacyFallback` is true.
 *
 * @param {string[]} providers
 * @param {string} project
 * @param {string} envName
 * @param {{ defaultEnvironment?: string|null, allowLegacyFallback?: boolean }} [options]
 */
export async function loadEnvArtifactHistory(providers, project, envName, options = {}) {
  if (!providers || providers.length === 0) {
    return { entries: [], source: null, key: envHistoryRemoteKey(project, envName) };
  }

  const envKey = envHistoryRemoteKey(project, envName);
  const tmp = uniqueTmpPath('deployhub-env-history');

  try {
    for (const name of providers) {
      try {
        const provider = getStorageProvider(name);
        const exists = await provider.verify(envKey);
        if (!exists) continue;

        await provider.download(envKey, tmp);
        const raw = await fs.readFile(tmp, 'utf8');
        return {
          entries: parseArtifactHistory(raw),
          source: name,
          key: envKey,
        };
      } catch (err) {
        const reason = summarizeStorageError(err);
        throw new Error(
          `Could not check remote history via ${name}: ${reason} — ` +
            'verify your storage credentials and configuration are correct.'
        );
      }
    }
  } finally {
    await fs.remove(tmp).catch(() => {});
  }

  const defaultName =
    typeof options.defaultEnvironment === 'string' ? options.defaultEnvironment : null;
  const allowLegacy =
    options.allowLegacyFallback !== false &&
    (envName === 'default' || (defaultName !== null && envName === defaultName));

  if (allowLegacy) {
    const legacy = await loadArtifactHistory(providers, project);
    if (legacy.entries.length > 0) {
      return {
        entries: legacy.entries,
        source: legacy.source,
        key: historyRemoteKey(project),
        legacyFallback: true,
      };
    }
  }

  return { entries: [], source: null, key: envKey };
}

/**
 * Record a successful deploy into per-env history + env latest pointer.
 * Does not touch other environments' history.
 *
 * @param {string[]} providers
 * @param {string} zipPath path to artifact.zip to copy into envs/{env}/latest/
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {{ buildId: string, semver?: string, remoteKey?: string }} meta
 */
export async function recordEnvDeployment(providers, zipPath, config, envName, meta) {
  const log = createLogger('storage');
  const buildId = meta.buildId;
  const remoteKey =
    meta.remoteKey || buildArtifactRemoteKey(config.project, buildId);
  const entry = {
    buildId,
    semver: String(meta.semver || config.version || '0.0.0').replace(/^v/i, ''),
    uploadedAt: new Date().toISOString(),
    remoteKey,
  };
  const envLatestKey = envLatestArtifactRemoteKey(config.project, envName);

  for (const name of providers) {
    const provider = getStorageProvider(name);
    log.info(`Recording deploy of ${buildId} to env "${envName}" on ${name}...`);

    if (zipPath && (await fs.pathExists(zipPath))) {
      await provider.upload(zipPath, envLatestKey);
    }

    const loaded = await loadEnvArtifactHistory([name], config.project, envName, {
      // Never seed deploy history from the project-wide build catalog on record.
      allowLegacyFallback: false,
    });
    const next = prependHistoryEntry(loaded.entries, entry);
    await writeEnvArtifactHistory(provider, config.project, envName, next);
  }
}

/**
 * Upload artifact zip under a unique build key, update latest/ pointer and history.json.
 * Does NOT write legacy `{project}/v{semver}/artifact.zip` (retired for new uploads;
 * legacy keys remain readable for older artifacts).
 *
 * @param {string[]} providers
 * @param {string} zipPath
 * @param {import('../core/config.js').DeployHubConfig} config
 */
export async function uploadToAll(providers, zipPath, config) {
  const log = createLogger('storage');
  ensureBuildIdentity(config);

  const buildId = /** @type {string} */ (config.buildId);
  const remoteKey = buildArtifactRemoteKey(config.project, buildId);
  const latestKey = latestArtifactRemoteKey(config.project);
  const entry = {
    buildId,
    semver: String(config.version || '0.0.0').replace(/^v/i, ''),
    uploadedAt: new Date().toISOString(),
    remoteKey,
  };

  const uploads = providers.map(async (name) => {
    try {
      const provider = getStorageProvider(name);
      log.info(`Uploading build ${buildId} to ${name}...`);
      await provider.upload(zipPath, remoteKey);
      // Intentional overwrite: mutable "current" pointer, not a versioned backup.
      await provider.upload(zipPath, latestKey);

      let history = [];
      try {
        const histKey = historyRemoteKey(config.project);
        if (await provider.verify(histKey)) {
          const tmp = uniqueTmpPath(`deployhub-hist-${name}`);
          try {
            await provider.download(histKey, tmp);
            history = parseArtifactHistory(await fs.readFile(tmp, 'utf8'));
          } finally {
            await fs.remove(tmp).catch(() => {});
          }
        }
      } catch {
        history = [];
      }

      const next = prependHistoryEntry(history, entry);
      await writeArtifactHistory(provider, config.project, next);

      log.success(`Uploaded to ${name} (${remoteKey})`);
      return { name, success: true, remoteKey, buildId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Storage upload to ${name} failed: ${message}`);
    }
  });

  return Promise.all(uploads);
}

/**
 * @param {string[]} providers
 * @param {string} remoteKey
 * @param {string} localPath
 */
export async function downloadFromFirst(providers, remoteKey, localPath) {
  for (const name of providers) {
    const provider = getStorageProvider(name);
    const exists = await provider.verify(remoteKey);
    if (exists) {
      await provider.download(remoteKey, localPath);
      return name;
    }
  }
  throw new Error(`Artifact not found in any configured storage provider`);
}

/**
 * Download a build by history entry, with legacy key fallback for pre-buildId uploads.
 *
 * @param {string[]} providers
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {{ remoteKey: string, buildId: string, semver: string }} entry
 * @param {string} localPath
 */
export async function downloadArtifactEntry(providers, config, entry, localPath) {
  try {
    return await downloadFromFirst(providers, entry.remoteKey, localPath);
  } catch {
    const legacyKey = legacyArtifactRemoteKey(config.project, entry.semver);
    const log = createLogger('storage');
    log.warn(
      `Build key not found; trying legacy key ${legacyKey} (may be an overwritten single-slot artifact)`
    );
    return downloadFromFirst(providers, legacyKey, localPath);
  }
}

/**
 * @param {string} name
 */
export async function testProvider(name) {
  const provider = getStorageProvider(name);
  await provider.testConnection();
}

/**
 * @param {string[]} providers
 */
export async function testAllProviders(providers) {
  const results = await Promise.allSettled(
    providers.map(async (name) => {
      await testProvider(name);
      return { name, status: 'connected' };
    })
  );

  return results.map((result, i) => {
    const name = providers[i];
    if (result.status === 'fulfilled') {
      return { name, status: 'connected' };
    }
    return {
      name,
      status: 'failed',
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  });
}

export default {
  getStorageProvider,
  uploadToAll,
  downloadFromFirst,
  downloadArtifactEntry,
  loadArtifactHistory,
  loadEnvArtifactHistory,
  ensureLegacyHistoryCopiedToDefaultEnv,
  recordEnvDeployment,
  testProvider,
  testAllProviders,
};
