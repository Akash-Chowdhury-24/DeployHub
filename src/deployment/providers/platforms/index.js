import { createVercelProvider } from './vercel.js';
import { createNetlifyProvider } from './netlify.js';
import { createCloudflarePagesProvider } from './cloudflare-pages.js';
import { createAwsAmplifyProvider } from './aws-amplify.js';
import { createAzureStaticWebAppsProvider } from './azure-static-web-apps.js';
import { createFirebaseHostingProvider } from './firebase-hosting.js';
import { createFirebaseAppHostingProvider } from './firebase-app-hosting.js';

/** @type {Record<string, Function>} */
const PLATFORM_FACTORIES = {
  vercel: createVercelProvider,
  netlify: createNetlifyProvider,
  'cloudflare-pages': createCloudflarePagesProvider,
  'aws-amplify': createAwsAmplifyProvider,
  'azure-static-web-apps': createAzureStaticWebAppsProvider,
  'firebase-hosting': createFirebaseHostingProvider,
  'firebase-app-hosting': createFirebaseAppHostingProvider,
};

/**
 * @param {string} platform
 * @param {import('../../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createPlatformProvider(platform, config, envName, env = process.env) {
  const factory = PLATFORM_FACTORIES[platform];
  if (!factory) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return factory(config, envName, env);
}

export {
  createVercelProvider,
  createNetlifyProvider,
  createCloudflarePagesProvider,
  createAwsAmplifyProvider,
  createAzureStaticWebAppsProvider,
  createFirebaseHostingProvider,
  createFirebaseAppHostingProvider,
};

export default { createPlatformProvider, PLATFORM_FACTORIES };
