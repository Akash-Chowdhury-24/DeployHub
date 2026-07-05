import fs from 'fs-extra';
import path from 'path';
import { getWorkflowHeaderComment } from './author.js';
import {
  generateDeploymentEnvSection,
  getDeploymentSecretKeys,
  DEPLOYMENT_ENV_KEYS,
} from '../deployment/deployment-env.js';

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
  ssh: DEPLOYMENT_ENV_KEYS.ssh,
  docker: DEPLOYMENT_ENV_KEYS.docker,
  ec2: DEPLOYMENT_ENV_KEYS.ec2,
  'azure-vm': DEPLOYMENT_ENV_KEYS['azure-vm'],
  'gcp-vm': DEPLOYMENT_ENV_KEYS['gcp-vm'],
  kubernetes: DEPLOYMENT_ENV_KEYS.kubernetes,
};

const PROVIDER_LABELS = {
  aws: 'AWS S3',
  azure: 'Azure Blob',
  gcp: 'GCP Storage',
  gdrive: 'Google Drive',
  dropbox: 'Dropbox',
  ftp: 'FTP',
  ssh: 'SSH Deployment',
  docker: 'Docker Deployment',
  ec2: 'AWS EC2 Deployment',
  'azure-vm': 'Azure VM Deployment',
  'gcp-vm': 'GCP VM Deployment',
  kubernetes: 'Kubernetes Deployment',
};

const ENV_VAR_DEFAULTS = {
  AWS_REGION: 'us-east-1',
  FTP_PORT: '21',
  FTP_PATH: '/uploads',
  SSH_DEPLOY_PATH: '/var/www/app',
  SSH_SSH_PORT: '22',
  SMTP_PORT: '587',
};

const NPM_PACKAGE = '@akash-chowdhury-24/deployhub';
export const DEFAULT_NPM_CLI_SOURCE = `npm:${NPM_PACKAGE}`;
export const GITHUB_CLI_TOKEN_SECRET = 'DEPLOYHUB_GITHUB_TOKEN';

/**
 * @param {string} [cliSource]
 * @returns {boolean}
 */
export function isGithubCliSource(cliSource) {
  const normalized = normalizeCliSource(cliSource);
  return normalized.startsWith('github:');
}

/**
 * Normalizes common GitHub remote formats to github:user/repo.
 * @param {string} cliSource
 * @returns {string}
 */
export function normalizeGithubCliSource(cliSource) {
  if (!cliSource) return cliSource;

  const trimmed = cliSource.trim();
  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/
  );
  if (httpsMatch) {
    return `github:${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `github:${sshMatch[1]}/${sshMatch[2]}`;
  }

  if (trimmed.startsWith('github:')) {
    return trimmed.replace(/^github:/, 'github:').replace(/\.git$/, '');
  }

  return trimmed;
}

/** @param {string} [cliSource] */
function normalizeCliSource(cliSource) {
  if (!cliSource) return DEFAULT_NPM_CLI_SOURCE;
  if (/^npm:(deployhub-cli|deploy-hub-cli|deployhub)$/.test(cliSource)) {
    return DEFAULT_NPM_CLI_SOURCE;
  }
  return normalizeGithubCliSource(cliSource);
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
 * Shell command to run deployhub build from the installed scoped package.
 * Uses node directly so it works reliably when installed from a private GitHub repo.
 * @returns {string}
 */
export function getCliBuildCommand() {
  return `node ./node_modules/${NPM_PACKAGE}/src/cli/index.js build`;
}

/**
 * @returns {string}
 */
function getGithubGitConfigStep() {
  return `      - name: Configure GitHub access for DeployHub CLI
        env:
          ${GITHUB_CLI_TOKEN_SECRET}: \${{ secrets.${GITHUB_CLI_TOKEN_SECRET} }}
          GITHUB_TOKEN: \${{ github.token }}
        run: |
          TOKEN="\${${GITHUB_CLI_TOKEN_SECRET}:-$GITHUB_TOKEN}"
          if [ -n "$TOKEN" ]; then
            git config --global url."https://oauth2:\${TOKEN}@github.com/".insteadOf "https://github.com/"
            git config --global url."https://oauth2:\${TOKEN}@github.com/".insteadOf "git@github.com:"
            git config --global url."https://oauth2:\${TOKEN}@github.com/".insteadOf "ssh://git@github.com/"
          else
            git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
            git config --global url."https://github.com/".insteadOf "git@github.com:"
          fi`;
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

const KUBECTL_VERSION = 'v1.30.4';

/**
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type: string }>} environments
 * @returns {boolean}
 */
function hasKubernetesDeploy(deployEnvironments, environments) {
  return deployEnvironments.some((envName) => environments[envName]?.type === 'kubernetes');
}

/**
 * @returns {string}
 */
function getKubernetesSetupSteps() {
  return `      - name: Setup kubectl
        uses: azure/setup-kubectl@v4
        with:
          version: '${KUBECTL_VERSION}'

      - name: Configure kubeconfig
        env:
          KUBECONFIG_SECRET: \${{ secrets.KUBECONFIG }}
        run: |
          mkdir -p "$GITHUB_WORKSPACE/.kube"
          if echo "$KUBECONFIG_SECRET" | base64 -d > "$GITHUB_WORKSPACE/.kube/config" 2>/dev/null; then
            :
          else
            printf '%s' "$KUBECONFIG_SECRET" > "$GITHUB_WORKSPACE/.kube/config"
          fi
          chmod 600 "$GITHUB_WORKSPACE/.kube/config"`;
}

/**
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type: string }>} environments
 * @param {Set<string>} envVars
 */
function applyKubernetesWorkflowEnv(deployEnvironments, environments, envVars) {
  if (!hasKubernetesDeploy(deployEnvironments, environments)) return;

  for (const entry of envVars) {
    if (entry.startsWith('KUBECONFIG:')) {
      envVars.delete(entry);
      break;
    }
  }
  envVars.add('KUBECONFIG: ${{ github.workspace }}/.kube/config');
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

    const keys = getDeploymentSecretKeys(env.type, config);
    for (const key of keys) {
      envVars.add(`${key}: \${{ secrets.${key} }}`);
    }
  }

  applyKubernetesWorkflowEnv(deployEnvironments, environments, envVars);

  const envBlock = Array.from(envVars)
    .map((line) => `          ${line}`)
    .join('\n');

  const installSpec = getCliInstallSpec(cliSource);
  const backendSteps = getBackendSetupSteps(config);
  const uniqueBackendSteps = [...new Set(backendSteps)].join('\n');
  const githubGitConfigStep = isGithubCliSource(cliSource)
    ? `${getGithubGitConfigStep()}\n`
    : '';
  const kubernetesSteps = hasKubernetesDeploy(deployEnvironments, environments)
    ? `${getKubernetesSetupSteps()}\n`
    : '';

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
${kubernetesSteps}${githubGitConfigStep}      - name: Install project dependencies
        run: ${installDepsCommand}
      - name: Install DeployHub CLI
        run: npm install ${installSpec} --no-save
      - run: ${getCliBuildCommand()}
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
  config = null,
  cliSource = null
) {
  /** @type {Set<string>} */
  const secrets = new Set();

  const resolvedCliSource = cliSource || config?.cli?.source;
  if (isGithubCliSource(resolvedCliSource)) {
    secrets.add(GITHUB_CLI_TOKEN_SECRET);
  }

  for (const provider of storageProviders) {
    const keys = PROVIDER_ENV_MAP[provider] || [];
    keys.forEach((k) => secrets.add(k));
  }

  for (const envName of deployEnvironments) {
    const env = environments[envName];
    if (!env) continue;

    const keys = getDeploymentSecretKeys(env.type, config);
    keys.forEach((k) => secrets.add(k));
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
    if (!env?.type) continue;

    const deploySection = generateDeploymentEnvSection(env.type, config, environments);
    if (deploySection) {
      sections.push(`${deploySection}\n`);
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
