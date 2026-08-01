import path from 'path';
import fs from 'fs-extra';
import os from 'os';
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
  const tmp = path.join(os.tmpdir(), `deployhub-history-${Date.now()}.json`);

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
  const tmp = path.join(os.tmpdir(), `deployhub-history-write-${Date.now()}.json`);
  await fs.writeJson(tmp, history, { spaces: 2 });
  try {
    await provider.upload(tmp, key);
  } finally {
    await fs.remove(tmp).catch(() => {});
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
          const tmp = path.join(os.tmpdir(), `deployhub-hist-${name}-${Date.now()}.json`);
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
  testProvider,
  testAllProviders,
};
