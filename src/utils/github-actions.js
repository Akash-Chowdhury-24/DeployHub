import fs from 'fs-extra';
import path from 'path';
import {
  PLATFORM_ENV_MAP,
  PLATFORM_CLI_MAP,
  PLATFORM_CHOICES,
  getPlatformEnvExample,
} from './platform-env.js';
import { getWorkflowHeaderComment } from './author.js';

/** @typedef {'aws'|'azure'|'gcp'|'gdrive'|'dropbox'|'local'|'ftp'|'ssh'} ProviderEnvKey */

const PROVIDER_ENV_MAP = {
  aws: [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_BUCKET',
    'AWS_REGION',
  ],
  azure: ['AZURE_CONNECTION_STRING', 'AZURE_CONTAINER'],
  gcp: ['GCP_PROJECT_ID', 'GCP_KEY_FILE', 'GCP_BUCKET'],
  gdrive: [
    'GDRIVE_CLIENT_ID',
    'GDRIVE_CLIENT_SECRET',
    'GDRIVE_REFRESH_TOKEN',
    'GDRIVE_FOLDER_ID',
  ],
  dropbox: ['DROPBOX_ACCESS_TOKEN'],
  local: [],
  ftp: ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD'],
  ssh: ['SSH_HOST', 'SSH_USER', 'SSH_KEY'],
};

const BACKEND_SSH_ENV_VARS = [
  'SSH_DEPLOY_PATH',
  'SSH_APP_NAME',
  'SSH_PORT',
];

const PROVIDER_LABELS = {
  aws: 'AWS S3',
  azure: 'Azure Blob',
  gcp: 'GCP',
  gdrive: 'Google Drive',
  dropbox: 'Dropbox',
  ftp: 'FTP',
  ssh: 'SSH Deployment',
};

const PLATFORM_LABELS = Object.fromEntries(
  PLATFORM_CHOICES.map(({ name, value }) => [value, name])
);

const ENV_VAR_DEFAULTS = {
  AWS_REGION: 'us-east-1',
  FTP_PORT: '21',
  FTP_PATH: '/uploads',
  SSH_DEPLOY_PATH: '/var/www/app',
  SMTP_PORT: '587',
};

const NPM_PACKAGE = '@akash-chowdhury-24/deployhub';
const DEFAULT_NPM_CLI_SOURCE = `npm:${NPM_PACKAGE}`;

/** @param {string} [cliSource] */
function normalizeCliSource(cliSource) {
  if (!cliSource) return DEFAULT_NPM_CLI_SOURCE;
  if (/^npm:(deployhub-cli|deploy-hub-cli|deployhub)$/.test(cliSource)) {
    return DEFAULT_NPM_CLI_SOURCE;
  }
  return cliSource;
}

/**
 * @param {string} cliSource
 * @returns {string}
 */
export function getCliInstallSpec(cliSource) {
  const normalized = normalizeCliSource(cliSource);
  if (normalized === DEFAULT_NPM_CLI_SOURCE) {
    return `${NPM_PACKAGE}@latest`;
  }
  if (normalized.startsWith('github:')) {
    return normalized;
  }
  if (normalized.startsWith('file:')) {
    return normalized;
  }
  return normalized;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string[]}
 */
function getBackendSetupSteps(config) {
  if (!config) return [];

  const projectType = config.projectType || 'frontend';
  if (projectType === 'frontend') return [];

  /** @type {string[]} */
  const steps = [];

  if (projectType === 'backend' || projectType === 'both') {
    const framework = config.backend?.framework || config.framework || 'express';
    if (['express', 'nestjs', 'fastify', 'koa', 'nextjs'].includes(framework)) {
      steps.push(`      - uses: actions/setup-node@v4
        with:
          node-version: '20'`);
    }
    if (['fastapi', 'django', 'flask'].includes(framework)) {
      steps.push(`      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'`);
    }
    if (['spring', 'java'].includes(framework)) {
      steps.push(`      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'`);
    }
    if (framework === 'go') {
      steps.push(`      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'`);
    }
    if (framework === 'dotnet') {
      steps.push(`      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'`);
    }
    if (framework === 'rails') {
      steps.push(`      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.2'
          bundler-cache: true`);
    }
  }

  return steps;
}

/**
 * @param {Record<string, unknown>[]} environments
 * @returns {string[]}
 */
function getPlatformInstallSteps(environments) {
  /** @type {Set<string>} */
  const steps = new Set();

  for (const env of environments) {
    if (env.deploymentType !== 'platform' && env.frontendDeploymentType !== 'platform') {
      continue;
    }
    const platform = env.platform;
    if (!platform) continue;
    const cli = PLATFORM_CLI_MAP[platform];
    if (cli?.globalInstall) {
      steps.add(`      - name: Install ${platform} CLI\n        run: ${cli.globalInstall}`);
    }
  }

  return Array.from(steps);
}

/**
 * @param {string[]} deployEnvironments
 * @param {Record<string, Record<string, unknown>>} environments
 */
function collectPlatformEnvVars(deployEnvironments, environments) {
  /** @type {Set<string>} */
  const envVars = new Set();

  for (const envName of deployEnvironments) {
    const env = environments[envName];
    if (!env) continue;

    if (env.deploymentType === 'platform' || env.frontendDeploymentType === 'platform') {
      const platform = env.platform;
      if (!platform) continue;
      const keys = PLATFORM_ENV_MAP[platform] || [];
      for (const key of keys) {
        envVars.add(`${key}: \${{ secrets.${key} }}`);
      }
    }
  }

  return envVars;
}

/**
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type: string }>} environments
 * @param {string} [cliSource]
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string}
 */
export function generateWorkflowYaml(
  storageProviders,
  deployEnvironments,
  environments,
  cliSource = DEFAULT_NPM_CLI_SOURCE,
  config = null
) {
  /** @type {Set<string>} */
  const envVars = new Set(['DEPLOYHUB_ENV: production']);

  for (const provider of storageProviders) {
    const keys = PROVIDER_ENV_MAP[provider] || [];
    for (const key of keys) {
      envVars.add(`${key}: \${{ secrets.${key} }}`);
    }
  }

  for (const envName of deployEnvironments) {
    const env = environments[envName];
    if (!env) continue;

    if (env.deploymentType !== 'platform') {
      const keys = PROVIDER_ENV_MAP[env.type] || [];
      for (const key of keys) {
        envVars.add(`${key}: \${{ secrets.${key} }}`);
      }
    }

    if (env.type === 'ssh' && config) {
      const projectType = config.projectType || 'frontend';
      if (projectType === 'backend' || projectType === 'both') {
        for (const key of BACKEND_SSH_ENV_VARS) {
          envVars.add(`${key}: \${{ secrets.${key} }}`);
        }
      }
    }
  }

  for (const line of collectPlatformEnvVars(deployEnvironments, environments)) {
    envVars.add(line);
  }

  const envBlock = Array.from(envVars)
    .map((line) => `          ${line}`)
    .join('\n');

  const installSpec = getCliInstallSpec(cliSource);
  const backendSteps = getBackendSetupSteps(config);
  const uniqueBackendSteps = [...new Set(backendSteps)].join('\n');

  const envList = deployEnvironments
    .map((name) => environments[name])
    .filter(Boolean);
  const platformSteps = getPlatformInstallSteps(envList).join('\n');

  const projectType = config?.projectType || 'frontend';
  const installDepsCommand =
    projectType === 'backend' || projectType === 'both'
      ? getInstallDepsCommand(config)
      : 'npm install';

  const workflow = `${getWorkflowHeaderComment()}name: DeployHub
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${uniqueBackendSteps ? `${uniqueBackendSteps}\n` : ''}      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install project dependencies
        run: ${installDepsCommand}
${platformSteps ? `${platformSteps}\n` : ''}      - name: Install DeployHub CLI
        run: npm install ${installSpec} --no-save
      - run: npx deployhub build
        env:
${envBlock}
`;

  return workflow;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string}
 */
function getInstallDepsCommand(config) {
  if (!config) return 'npm install';

  const framework =
    config.backend?.framework || config.framework || 'express';
  const language = config.backend?.language || config.language;

  if (language === 'python' || ['fastapi', 'django', 'flask'].includes(framework)) {
    return 'pip install -r requirements.txt';
  }
  if (['laravel', 'symfony'].includes(framework)) {
    return 'composer install --no-interaction';
  }
  if (framework === 'spring' || framework === 'java') {
    return 'mvn dependency:resolve || true';
  }
  if (framework === 'go') {
    return 'go mod download';
  }
  if (framework === 'dotnet') {
    return 'dotnet restore';
  }
  if (framework === 'rails') {
    return 'bundle install';
  }
  return 'npm install';
}

/**
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type: string }>} environments
 * @param {string} [cwd]
 * @param {string} [cliSource]
 * @param {import('../core/config.js').DeployHubConfig} [config]
 */
export async function writeWorkflowFile(
  storageProviders,
  deployEnvironments,
  environments,
  cwd = process.cwd(),
  cliSource = DEFAULT_NPM_CLI_SOURCE,
  config = null
) {
  const workflowDir = path.join(cwd, '.github', 'workflows');
  await fs.ensureDir(workflowDir);
  const content = generateWorkflowYaml(
    storageProviders,
    deployEnvironments,
    environments,
    cliSource,
    config
  );
  await fs.writeFile(path.join(workflowDir, 'deployhub.yml'), content);
}

/**
 * @param {string} cliSource
 * @param {string} [cwd]
 */
export async function addDeployhubToPackageJson(cliSource, cwd = process.cwd()) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!(await fs.pathExists(pkgPath))) return;

  const pkg = await fs.readJson(pkgPath);
  pkg.devDependencies = pkg.devDependencies || {};
  pkg.devDependencies[NPM_PACKAGE] = getCliInstallSpec(cliSource);
  delete pkg.devDependencies.deployhub;
  pkg.scripts = pkg.scripts || {};
  pkg.scripts['deployhub:build'] = 'deployhub build';
  await fs.writeJson(pkgPath, pkg, { spaces: 2 });
}

/**
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function guessCliGithubRepo(cwd = process.cwd()) {
  try {
    const { execa } = await import('execa');
    const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], {
      cwd,
      stdio: 'pipe',
    });
    const match = stdout.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
    if (match) {
      return `github:${match[1]}/deployhub`;
    }
  } catch {
    // ignore
  }
  return 'github:YOUR_USERNAME/deployhub';
}

/**
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type: string }>} environments
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string[]}
 */
export function getRequiredSecrets(
  storageProviders,
  deployEnvironments,
  environments,
  config = null
) {
  /** @type {Set<string>} */
  const secrets = new Set();

  for (const provider of storageProviders) {
    const keys = PROVIDER_ENV_MAP[provider] || [];
    keys.forEach((k) => secrets.add(k));
  }

  for (const envName of deployEnvironments) {
    const env = environments[envName];
    if (!env) continue;

    if (env.deploymentType === 'platform' || env.frontendDeploymentType === 'platform') {
      const platform = env.platform;
      if (platform) {
        const keys = PLATFORM_ENV_MAP[platform] || [];
        keys.forEach((k) => secrets.add(k));
      }
    } else {
      const keys = PROVIDER_ENV_MAP[env.type] || [];
      keys.forEach((k) => secrets.add(k));
    }

    if (env.type === 'ssh' && config) {
      const projectType = config.projectType || 'frontend';
      if (projectType === 'backend' || projectType === 'both') {
        BACKEND_SSH_ENV_VARS.forEach((k) => secrets.add(k));
      }
    }
  }

  return Array.from(secrets);
}

/**
 * @param {string} title
 * @param {string[]} keys
 * @param {Record<string, string>} [defaults]
 * @param {Set<string>} seenKeys
 * @returns {string}
 */
function formatEnvSection(title, keys, defaults, seenKeys) {
  const newKeys = keys.filter((key) => !seenKeys.has(key));
  if (newKeys.length === 0) return '';

  for (const key of newKeys) {
    seenKeys.add(key);
  }

  const lines = newKeys.map((key) => {
    const value = defaults?.[key] ?? ENV_VAR_DEFAULTS[key] ?? '';
    return value ? `${key}=${value}` : `${key}=`;
  });

  return `# ${title}\n${lines.join('\n')}\n`;
}

/**
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, Record<string, unknown>>} environments
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string}
 */
export function generateEnvExampleContent(
  storageProviders,
  deployEnvironments,
  environments,
  config = null
) {
  /** @type {Set<string>} */
  const seenKeys = new Set();
  /** @type {string[]} */
  const sections = [];

  const addSection = (title, keys, defaults = {}) => {
    const section = formatEnvSection(title, keys, defaults, seenKeys);
    if (section) sections.push(section);
  };

  for (const provider of storageProviders) {
    const keys = PROVIDER_ENV_MAP[provider] || [];
    if (keys.length > 0) {
      addSection(PROVIDER_LABELS[provider] || provider, keys);
    }
  }

  for (const envName of deployEnvironments) {
    const env = environments[envName];
    if (!env) continue;

    if (env.deploymentType === 'platform' || env.frontendDeploymentType === 'platform') {
      const platform = env.platform;
      if (platform) {
        const examples = getPlatformEnvExample(platform);
        addSection(
          PLATFORM_LABELS[platform] || platform,
          Object.keys(examples),
          examples
        );
      }
      continue;
    }

    const keys = PROVIDER_ENV_MAP[env.type] || [];
    if (keys.length > 0) {
      addSection(PROVIDER_LABELS[env.type] || env.type, keys);
    }

    if (env.type === 'ssh' && config) {
      const projectType = config.projectType || 'frontend';
      if (projectType === 'backend' || projectType === 'both') {
        addSection('SSH Deployment (backend)', BACKEND_SSH_ENV_VARS);
      }
    }
  }

  if (config?.notifications) {
    if (config.notifications.slack) {
      addSection('Notifications', ['SLACK_WEBHOOK_URL']);
    }
    if (config.notifications.webhook) {
      addSection('Notifications', ['WEBHOOK_URL']);
    }
    if (config.notifications.email) {
      addSection('Email (SMTP)', [
        'SMTP_HOST',
        'SMTP_PORT',
        'SMTP_USER',
        'SMTP_PASS',
        'NOTIFICATION_EMAIL',
        'NOTIFY_EMAIL_TO',
      ]);
    }
  }

  if (sections.length === 0) {
    return '# Add your environment variables here\n';
  }

  return `${sections.join('\n')}\n`;
}

export { PROVIDER_ENV_MAP };
