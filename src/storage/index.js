import path from 'path';
import { createLogger } from '../logger/index.js';
import { createAwsProvider } from './providers/aws.js';
import { createLocalProvider } from './providers/local.js';
import { createAzureProvider } from './providers/azure.js';
import { createGcpProvider } from './providers/gcp.js';
import { createGdriveProvider } from './providers/gdrive.js';
import { createDropboxProvider } from './providers/dropbox.js';
import { createFtpProvider } from './providers/ftp.js';

/** @type {Record<string, (env?: Record<string, string>) => import('./providers/aws.js').default>} */
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
 * @param {string[]} providers
 * @param {string} zipPath
 * @param {import('../core/config.js').DeployHubConfig} config
 */
export async function uploadToAll(providers, zipPath, config) {
  const log = createLogger('storage');
  const remoteKey = `${config.project}/v${config.version}/artifact.zip`;

  const uploads = providers.map(async (name) => {
    try {
      const provider = getStorageProvider(name);
      log.info(`Uploading to ${name}...`);
      await provider.upload(zipPath, remoteKey);
      log.success(`Uploaded to ${name}`);
      return { name, success: true };
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
      status: 'error',
      error: result.reason?.message || String(result.reason),
    };
  });
}

export { PROVIDER_FACTORIES };
export default { getStorageProvider, uploadToAll, downloadFromFirst, testProvider, testAllProviders };
