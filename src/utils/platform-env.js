/** Platform deployment environment variables and CLI metadata. */

export const PLATFORM_ENV_MAP = {
  vercel: ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'],
  netlify: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'],
  'cloudflare-pages': [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_PROJECT_NAME',
  ],
  'aws-amplify': [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AMPLIFY_APP_ID',
  ],
  'azure-static-web-apps': ['AZURE_STATIC_WEB_APPS_TOKEN'],
  'firebase-hosting': ['FIREBASE_TOKEN', 'FIREBASE_PROJECT_ID'],
  'firebase-app-hosting': [
    'FIREBASE_TOKEN',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_APP_HOSTING_BACKEND',
  ],
};

export const PLATFORM_CLI_MAP = {
  vercel: { install: 'vercel', binary: 'vercel', globalInstall: 'npm install -g vercel' },
  netlify: {
    install: 'netlify-cli',
    binary: 'netlify',
    globalInstall: 'npm install -g netlify-cli',
  },
  'cloudflare-pages': {
    install: 'wrangler',
    binary: 'wrangler',
    globalInstall: 'npm install -g wrangler',
  },
  'aws-amplify': {
    install: 'aws-cli',
    binary: 'aws',
    globalInstall: null,
  },
  'azure-static-web-apps': {
    install: '@azure/static-web-apps-cli',
    binary: 'swa',
    globalInstall: 'npm install -g @azure/static-web-apps-cli',
  },
  'firebase-hosting': {
    install: 'firebase-tools',
    binary: 'firebase',
    globalInstall: 'npm install -g firebase-tools',
  },
  'firebase-app-hosting': {
    install: 'firebase-tools',
    binary: 'firebase',
    globalInstall: 'npm install -g firebase-tools',
  },
};

export const PLATFORM_CHOICES = [
  { name: 'Vercel', value: 'vercel' },
  { name: 'Netlify', value: 'netlify' },
  { name: 'Cloudflare Pages', value: 'cloudflare-pages' },
  { name: 'AWS Amplify', value: 'aws-amplify' },
  { name: 'Azure Static Web Apps', value: 'azure-static-web-apps' },
  { name: 'Firebase Hosting', value: 'firebase-hosting' },
  { name: 'Firebase App Hosting', value: 'firebase-app-hosting' },
];

export const PLATFORM_COMPARISON = `
  Platform                Best for
  ─────────────────────────────────────────────────────────────
  Vercel                  Next.js (best experience), React
  Netlify                 React, Vue, Svelte — simplest setup
  Cloudflare Pages        Static sites, Astro, React — fastest CDN
  AWS Amplify             React, Next.js, Vue, Angular — AWS ecosystem
  Azure Static Web Apps   React, Angular, Blazor — Azure ecosystem
  Firebase Hosting        Static SPAs — Google ecosystem
  Firebase App Hosting    Next.js, Angular with SSR — Google ecosystem

  All platforms include: free SSL, global CDN, custom domain, auto-deploy
`;

/**
 * @param {string} platform
 * @returns {Record<string, string>}
 */
export function getPlatformEnvExample(platform) {
  const examples = {
    vercel: {
      VERCEL_TOKEN: '',
      VERCEL_ORG_ID: '',
      VERCEL_PROJECT_ID: '',
    },
    netlify: {
      NETLIFY_AUTH_TOKEN: '',
      NETLIFY_SITE_ID: '',
    },
    'cloudflare-pages': {
      CLOUDFLARE_API_TOKEN: '',
      CLOUDFLARE_ACCOUNT_ID: '',
      CF_PROJECT_NAME: '',
    },
    'aws-amplify': {
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_REGION: 'us-east-1',
      AMPLIFY_APP_ID: '',
    },
    'azure-static-web-apps': {
      AZURE_STATIC_WEB_APPS_TOKEN: '',
    },
    'firebase-hosting': {
      FIREBASE_TOKEN: '',
      FIREBASE_PROJECT_ID: '',
    },
    'firebase-app-hosting': {
      FIREBASE_TOKEN: '',
      FIREBASE_PROJECT_ID: '',
      FIREBASE_APP_HOSTING_BACKEND: '',
    },
  };
  return examples[platform] || {};
}

export default {
  PLATFORM_ENV_MAP,
  PLATFORM_CLI_MAP,
  PLATFORM_CHOICES,
  PLATFORM_COMPARISON,
  getPlatformEnvExample,
};
