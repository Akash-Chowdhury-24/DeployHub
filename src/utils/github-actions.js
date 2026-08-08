import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { getWorkflowHeaderComment } from './author.js';
import {
  generateDeploymentEnvSection,
  getDeploymentWorkflowSecretKeys,
  getDeploymentSecretChecklistItems,
  getDeploymentWorkflowSecretKeysForEnv,
  getDeploymentSecretChecklistItemsForEnv,
  shouldPrefixEnvSecrets,
  prefixSecretKey,
  envUsesPrefixedSecrets,
  DEPLOYMENT_ENV_KEYS,
} from '../deployment/deployment-env.js';
import {
  getEnvMethod,
  getEnabledEnvironmentNames,
  isEnvEnabled,
} from '../core/environments.js';

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
 * Version/range suitable as a package.json dependency VALUE for this CLI
 * (key is already NPM_PACKAGE — do not embed the package name again).
 *
 * @param {string} [cliSource]
 * @returns {string}
 */
export function getCliPackageJsonDependencyVersion(cliSource) {
  const normalized = normalizeCliSource(cliSource);
  if (normalized === DEFAULT_NPM_CLI_SOURCE) {
    try {
      const pkgPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../package.json'
      );
      const pkg = fs.readJsonSync(pkgPath);
      if (typeof pkg.version === 'string' && pkg.version.trim()) {
        return `^${pkg.version.trim()}`;
      }
    } catch {
      // fall through
    }
    return 'latest';
  }
  // github: / file: specs are valid package.json dependency values as-is
  return getCliInstallSpec(cliSource);
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
  return deployEnvironments.some(
    (envName) => getEnvMethod(environments[envName]) === 'kubernetes'
  );
}

/**
 * Secret name for the Configure-kubeconfig setup step.
 * Must match the env that actually uses kubernetes — when the only k8s env is
 * non-grandfathered (e.g. production), that is PRODUCTION_KUBECONFIG, not the
 * unprefixed KUBECONFIG (which would never be injected and leave the file empty).
 *
 * LIMITATION (follow-up): GitHub Actions writes exactly ONE kubeconfig file per
 * job. Multiple Kubernetes environments that target DIFFERENT clusters in the
 * same workflow run are not yet fully supported — only the first/grandfathered
 * k8s env's secret is used for the setup step. Track as a product follow-up
 * before advertising multi-cluster multi-env CI.
 *
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type?: string, method?: string }>} environments
 * @param {import('../core/config.js').DeployHubConfig|null} config
 * @returns {string}
 */
function resolveKubeconfigWorkflowSecretName(deployEnvironments, environments, config) {
  const cfg = { ...(config || {}), environments };
  const k8sNames = deployEnvironments.filter(
    (n) => getEnvMethod(environments[n]) === 'kubernetes'
  );
  if (k8sNames.length === 0) return 'KUBECONFIG';
  const unprefixed = k8sNames.find((n) => !envUsesPrefixedSecrets(n, cfg));
  const chosen = unprefixed || k8sNames[0];
  return envUsesPrefixedSecrets(chosen, cfg)
    ? prefixSecretKey(chosen, 'KUBECONFIG')
    : 'KUBECONFIG';
}

/**
 * @param {string} [kubeconfigSecretName]
 * @returns {string}
 */
function getKubernetesSetupSteps(kubeconfigSecretName = 'KUBECONFIG') {
  // One kubeconfig file per job — see resolveKubeconfigWorkflowSecretName LIMITATION.
  return `      - name: Setup kubectl
        uses: azure/setup-kubectl@v4
        with:
          version: '${KUBECTL_VERSION}'

      - name: Configure kubeconfig
        env:
          KUBECONFIG_SECRET: \${{ secrets.${kubeconfigSecretName} }}
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

export const DEPLOY_WORKFLOW_FILENAME = 'deployhub.yml';
export const ROLLBACK_WORKFLOW_FILENAME = 'deployhub-rollback.yml';

/**
 * Upsert a `KEY: value` line into the workflow env set (LHS must be unique for valid YAML).
 * @param {Set<string>} envVars
 * @param {string} lhs
 * @param {string} valueExpr
 */
function upsertWorkflowEnvLine(envVars, lhs, valueExpr) {
  const linePrefix = `${lhs}: `;
  for (const entry of [...envVars]) {
    if (entry.startsWith(linePrefix)) {
      envVars.delete(entry);
    }
  }
  envVars.add(`${linePrefix}${valueExpr}`);
}

/**
 * Shared env entries for deploy and rollback workflows (same secret resolution).
 * Multi-env: each environment contributes its own CI secret names (grandfathered
 * unprefixed SSH_HOST, or PRODUCTION_SSH_HOST, etc.). Prefixed envs are NOT
 * last-wins-mapped onto unprefixed keys — that would overwrite the grandfathered
 * binding and leave production looking fine in YAML while development silently
 * inherits the wrong credentials. `applyEnvSecretOverlay` remaps PREFIX_* →
 * unprefixed names at deploy time for non-grandfathered targets.
 *
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments — environments whose secrets to inject
 * @param {Record<string, { type?: string, method?: string }>} environments
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {Set<string>}
 */
export function buildWorkflowEnvEntries(
  storageProviders,
  deployEnvironments,
  environments,
  config = null
) {
  /** @type {Set<string>} */
  const envVars = new Set([
    `DEPLOYHUB_ENV: ${deployEnvironments[0] || 'production'}`,
  ]);

  for (const provider of storageProviders) {
    const keys = PROVIDER_ENV_MAP[provider] || [];
    for (const key of keys) {
      upsertWorkflowEnvLine(envVars, key, `\${{ secrets.${key} }}`);
    }
  }

  const cfg = { ...(config || {}), environments };

  for (const envName of deployEnvironments) {
    const env = environments[envName];
    if (!env) continue;

    const method = getEnvMethod(env);
    if (!method) continue;
    const unprefixedKeys = getDeploymentWorkflowSecretKeys(method, config);
    for (const key of unprefixedKeys) {
      const secretName = envUsesPrefixedSecrets(envName, cfg)
        ? prefixSecretKey(envName, key)
        : key;
      // Bind process.env[secretName] for this environment (prefixed or grandfathered).
      upsertWorkflowEnvLine(envVars, secretName, `\${{ secrets.${secretName} }}`);
    }
  }

  applyKubernetesWorkflowEnv(deployEnvironments, environments, envVars);
  return envVars;
}

/**
 * Choice options for workflow_dispatch — enabled environments only, plus `all`.
 * Disabled envs are omitted so selecting them cannot waste a CI run.
 *
 * @param {Record<string, unknown>} environments
 * @returns {string}
 */
function formatEnvironmentChoiceOptions(environments) {
  // Single source of truth: getEnabledEnvironmentNames (do not re-filter here).
  const names = getEnabledEnvironmentNames({ environments });
  const options = [...names, 'all'];
  return options.map((n) => `          - ${n}`).join('\n');
}

/**
 * @param {Set<string>} envVars
 * @param {string} [indent]
 */
function formatWorkflowEnvBlock(envVars, indent = '          ') {
  return Array.from(envVars)
    .map((line) => `${indent}${line}`)
    .join('\n');
}

/**
 * Shell command to run deployhub rollback from the installed scoped package.
 * @returns {string}
 */
export function getCliRollbackCommand() {
  return `node ./node_modules/${NPM_PACKAGE}/src/cli/index.js rollback`;
}

/**
 * Collect secret names referenced as ${{ secrets.NAME }} in workflow YAML.
 * @param {string} yaml
 * @returns {string[]}
 */
export function extractWorkflowSecretKeys(yaml) {
  /** @type {Set<string>} */
  const keys = new Set();
  const re = /\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g;
  let match;
  while ((match = re.exec(yaml)) !== null) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

/**
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type?: string, method?: string }>} environments
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
  const envNames = Object.keys(environments || {});
  // Secret injection uses ALL enabled environments (not push-only / pipelineDeployTargets).
  // Prefer live enabled names over a possibly-stale deploy[] argument so no enabled
  // env is missing from the job env block. Canonical helper: getEnabledEnvironmentNames.
  const enabledEnvs = getEnabledEnvironmentNames({ ...(config || {}), environments });
  const allDeployNames =
    enabledEnvs.length > 0
      ? enabledEnvs
      : deployEnvironments.length > 0
        ? deployEnvironments
        : envNames;

  // CRITICAL: Build and Deploy (workflow_dispatch) MUST share the same secret union —
  // every enabled environment. Filtering Build to push-only caused a live regression:
  // Dispatch correctly got PRODUCTION_* while Build did not, so `deployhub build`'s
  // push deploy stage failed on production with a missing SSH key. Trigger only
  // controls which envs the CLI deploys; it must not control which secrets are injected.
  const secretEnvs =
    allDeployNames.length > 0 ? allDeployNames : envNames.slice(0, 1);

  const envVars = buildWorkflowEnvEntries(
    storageProviders,
    secretEnvs,
    environments,
    config
  );
  const envBlock = formatWorkflowEnvBlock(envVars);

  const installSpec = getCliInstallSpec(cliSource);
  const backendSteps = getBackendSetupSteps(config);
  const uniqueBackendSteps = [...new Set(backendSteps)].join('\n');
  const githubGitConfigStep = isGithubCliSource(cliSource)
    ? `${getGithubGitConfigStep()}\n`
    : '';
  const kubeconfigSecret = resolveKubeconfigWorkflowSecretName(
    allDeployNames,
    environments,
    config
  );
  const kubernetesSteps = hasKubernetesDeploy(allDeployNames, environments)
    ? `${getKubernetesSetupSteps(kubeconfigSecret)}\n`
    : '';

  const projectType = config?.projectType || 'frontend';
  const installDepsCommand =
    projectType === 'backend' || projectType === 'both'
      ? getInstallDepsCommand(config)
      : 'npm install';

  const envChoiceOptions = formatEnvironmentChoiceOptions(environments);
  const hasEnvs = envNames.length > 0;
  const dispatchInputs = hasEnvs
    ? `  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to deploy (leave blank on push; use "all" for every enabled env)'
        required: false
        type: choice
        options:
${envChoiceOptions}
`
    : `  workflow_dispatch:
`;

  const manualDeployStep = hasEnvs
    ? `      - name: Deploy (workflow_dispatch)
        if: github.event_name == 'workflow_dispatch'
        env:
${envBlock}
        run: |
          ENV_INPUT="\${{ inputs.environment }}"
          if [ -z "$ENV_INPUT" ] || [ "$ENV_INPUT" = "all" ]; then
            ${getCliDeployCommand()} --env all
          else
            ${getCliDeployCommand()} --env "$ENV_INPUT"
          fi
`
    : '';

  const workflow = `${getWorkflowHeaderComment()}name: DeployHub
on:
  push:
    branches: [main]
${dispatchInputs}jobs:
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
      - name: Build (and auto-deploy push-triggered envs)
        run: ${getCliBuildCommand()}
        env:
${envBlock}
${manualDeployStep}`;

  return workflow;
}

/**
 * Shell command to run deployhub deploy from the installed scoped package.
 * @returns {string}
 */
export function getCliDeployCommand() {
  return `node ./node_modules/${NPM_PACKAGE}/src/cli/index.js deploy`;
}

/**
 * Manual rollback via Actions tab / gh workflow run (workflow_dispatch only).
 *
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type?: string, method?: string }>} environments
 * @param {string} [cliSource]
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string}
 */
export function generateRollbackWorkflowYaml(
  storageProviders,
  deployEnvironments,
  environments,
  cliSource = DEFAULT_NPM_CLI_SOURCE,
  config = null
) {
  const envNames = Object.keys(environments || {});
  const enabledEnvs = getEnabledEnvironmentNames({ ...(config || {}), environments });
  const allDeployNames =
    enabledEnvs.length > 0
      ? enabledEnvs
      : deployEnvironments.length > 0
        ? deployEnvironments
        : envNames.filter((n) => isEnvEnabled(environments[n]));

  const envVars = buildWorkflowEnvEntries(
    storageProviders,
    allDeployNames,
    environments,
    config
  );
  const envBlock = formatWorkflowEnvBlock(envVars);

  const installSpec = getCliInstallSpec(cliSource);
  const githubGitConfigStep = isGithubCliSource(cliSource)
    ? `${getGithubGitConfigStep()}\n`
    : '';
  const kubeconfigSecret = resolveKubeconfigWorkflowSecretName(
    allDeployNames,
    environments,
    config
  );
  const kubernetesSteps = hasKubernetesDeploy(allDeployNames, environments)
    ? `${getKubernetesSetupSteps(kubeconfigSecret)}\n`
    : '';

  const rollbackCmd = getCliRollbackCommand();
  const envChoiceOptions = formatEnvironmentChoiceOptions(environments);
  const hasEnvs = envNames.length > 0;

  const environmentInput = hasEnvs
    ? `      environment:
        description: 'Environment to roll back (or "all")'
        required: false
        type: choice
        options:
${envChoiceOptions}
`
    : '';

  const rollbackRun = hasEnvs
    ? `          ENV_INPUT="\${{ inputs.environment }}"
          BUILD_INPUT="\${{ inputs.buildId }}"
          ENV_FLAG=""
          if [ -z "$ENV_INPUT" ] || [ "$ENV_INPUT" = "all" ]; then
            ENV_FLAG="--env all"
          else
            ENV_FLAG="--env $ENV_INPUT"
          fi
          if [ -n "$BUILD_INPUT" ]; then
            ${rollbackCmd} "$BUILD_INPUT" $ENV_FLAG
          else
            ${rollbackCmd} $ENV_FLAG
          fi`
    : `          if [ -n "\${{ inputs.buildId }}" ]; then
            ${rollbackCmd} "\${{ inputs.buildId }}"
          else
            ${rollbackCmd}
          fi`;

  return `${getWorkflowHeaderComment()}name: DeployHub Rollback
on:
  workflow_dispatch:
    inputs:
      buildId:
        description: 'Exact buildId to restore (leave blank = previous build)'
        required: false
        type: string
${environmentInput}jobs:
  rollback:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
${kubernetesSteps}${githubGitConfigStep}      - name: Install DeployHub CLI
        run: npm install ${installSpec} --no-save
      - name: Rollback
        env:
${envBlock}
        run: |
${rollbackRun}
`;
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
 * Write deployhub.yml and deployhub-rollback.yml from the same secret/env helpers.
 *
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

  const deployContent = generateWorkflowYaml(
    storageProviders,
    deployEnvironments,
    environments,
    cliSource,
    config
  );
  const rollbackContent = generateRollbackWorkflowYaml(
    storageProviders,
    deployEnvironments,
    environments,
    cliSource,
    config
  );

  await fs.writeFile(path.join(workflowDir, DEPLOY_WORKFLOW_FILENAME), deployContent);
  await fs.writeFile(path.join(workflowDir, ROLLBACK_WORKFLOW_FILENAME), rollbackContent);
}

/**
 * Doctor helper: informational status for the rollback workflow file.
 * Returns null when the check does not apply (no storage/deploy configured).
 *
 * @param {string} cwd
 * @param {{ storage?: string[], deploy?: string[] }} config
 * @returns {Promise<null | { name: string, pass: boolean, message: string }>}
 */
export async function getRollbackWorkflowDoctorCheck(cwd, config) {
  const hasStorage = (config.storage || []).length > 0;
  const hasDeploy = (config.deploy || []).length > 0;
  if (!hasStorage || !hasDeploy) return null;

  const rollbackPath = path.join(cwd, '.github', 'workflows', ROLLBACK_WORKFLOW_FILENAME);
  if (await fs.pathExists(rollbackPath)) {
    return {
      name: 'Rollback workflow',
      pass: true,
      message: `Workflow file exists at .github/workflows/${ROLLBACK_WORKFLOW_FILENAME}`,
    };
  }

  return {
    name: 'Rollback workflow',
    pass: true,
    message:
      `Missing .github/workflows/${ROLLBACK_WORKFLOW_FILENAME} — ` +
      'run deployhub sync-workflows to add CI rollback (workflow_dispatch)',
  };
}

/**
 * Expected CI secret names for the current config — same set a fresh
 * `sync-workflows` would reference (via buildWorkflowEnvEntries).
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {'deploy'|'rollback'} [kind]
 * @returns {Set<string>}
 */
export function expectedWorkflowSecretKeysFromConfig(config, kind = 'rollback') {
  const environments = config.environments || {};
  const allNames = Object.keys(environments);
  /** @type {string[]} */
  let targets;
  if (kind === 'deploy') {
    const enabled = getEnabledEnvironmentNames({ ...config, environments });
    // Same union as generateWorkflowYaml Build + dispatch steps (all enabled).
    targets = enabled.length > 0 ? enabled : allNames.slice(0, 1);
  } else {
    targets =
      allNames.length > 0
        ? getEnabledEnvironmentNames({ ...config, environments })
        : allNames;
    if (targets.length === 0) targets = allNames;
  }

  const entries = buildWorkflowEnvEntries(
    config.storage || [],
    targets,
    environments,
    config
  );

  /** @type {Set<string>} */
  const keys = new Set();
  const re = /secrets\.([A-Z0-9_]+)/g;
  for (const line of entries) {
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(line)) !== null) {
      keys.add(match[1]);
    }
  }
  return keys;
}

/**
 * Lightweight drift check: checked-in workflow vs current config.
 * Catches missing dispatch env options and missing required secret references.
 *
 * @param {string} yamlText
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} [filename]
 * @returns {{ drifted: boolean, missingEnvs: string[], missingSecrets: string[], summary: string }}
 */
export function detectWorkflowConfigDrift(yamlText, config, filename = DEPLOY_WORKFLOW_FILENAME) {
  /** @type {string[]} */
  const missingEnvs = [];
  /** @type {string[]} */
  const missingSecrets = [];

  let parsed;
  try {
    parsed = yaml.load(yamlText);
  } catch {
    return {
      drifted: false,
      missingEnvs,
      missingSecrets,
      summary: '',
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { drifted: false, missingEnvs, missingSecrets, summary: '' };
  }

  const envNames = getEnabledEnvironmentNames(config);
  const root = /** @type {Record<string, any>} */ (parsed);
  const options = root?.on?.workflow_dispatch?.inputs?.environment?.options;

  if (Array.isArray(options) && envNames.length > 0) {
    const optionSet = new Set(options.map(String));
    for (const name of envNames) {
      if (!optionSet.has(name)) missingEnvs.push(name);
    }
  } else if (envNames.length > 1) {
    // Multi-env config but no dispatch dropdown — stale single-env workflow.
    missingEnvs.push(...envNames);
  }

  const kind = filename.includes('rollback') ? 'rollback' : 'deploy';
  const fileSecrets = new Set(extractWorkflowSecretKeys(yamlText));
  const expected = expectedWorkflowSecretKeysFromConfig(config, kind);
  for (const key of expected) {
    if (!fileSecrets.has(key)) missingSecrets.push(key);
  }

  const drifted = missingEnvs.length > 0 || missingSecrets.length > 0;
  /** @type {string[]} */
  const parts = [];
  if (missingEnvs.length > 0) {
    parts.push(
      `missing: ${missingEnvs.map((n) => `"${n}"`).join(', ')} in the dispatch dropdown`
    );
  }
  if (missingSecrets.length > 0) {
    const shown = missingSecrets.slice(0, 4);
    parts.push(
      `missing secret(s): ${shown.join(', ')}${missingSecrets.length > 4 ? ', …' : ''}`
    );
  }

  return {
    drifted,
    missingEnvs,
    missingSecrets,
    summary: parts.join('; '),
  };
}

/**
 * Doctor helper: informational checks when checked-in workflows drift from config.
 * Skips missing/unparseable files (other checks cover "file missing").
 * Returns an empty array when everything is in sync or not applicable.
 *
 * @param {string} cwd
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {Promise<{ name: string, pass: boolean, message: string }[]>}
 */
export async function getWorkflowDriftDoctorChecks(cwd, config) {
  const envCount = Object.keys(config.environments || {}).length;
  if (envCount === 0) return [];

  /** @type {{ name: string, pass: boolean, message: string }[]} */
  const checks = [];
  const files = [DEPLOY_WORKFLOW_FILENAME, ROLLBACK_WORKFLOW_FILENAME];

  for (const filename of files) {
    const filePath = path.join(cwd, '.github', 'workflows', filename);
    if (!(await fs.pathExists(filePath))) continue;

    let text;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const drift = detectWorkflowConfigDrift(text, config, filename);
    if (!drift.drifted) continue;

    checks.push({
      name: `Workflow sync (${filename})`,
      // Informational nudge — same pattern as missing rollback workflow (pass: true).
      pass: true,
      message:
        `.github/workflows/${filename} looks out of date with your current environments config ` +
        `(${drift.summary}). Run: deployhub sync-workflows`,
    });
  }

  return checks;
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
  // package.json value must be a semver range / "latest" / git URL — never "name@version"
  // (that form is only for `npm install <spec>` via getCliInstallSpec).
  pkg.devDependencies[NPM_PACKAGE] = getCliPackageJsonDependencyVersion(cliSource);
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
 * Flat list of required secret key names (for callers that only need keys).
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type: string }>} environments
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {string|null} [cliSource]
 * @returns {string[]}
 */
export function getRequiredSecrets(
  storageProviders,
  deployEnvironments,
  environments,
  config = null,
  cliSource = null
) {
  return getGithubSecretsChecklist(
    storageProviders,
    deployEnvironments,
    environments,
    config,
    cliSource
  )
    .filter((item) => item.required)
    .map((item) => item.key);
}

/**
 * Labeled GitHub Secrets checklist (required + optional) for post-init output.
 * @param {string[]} storageProviders
 * @param {string[]} deployEnvironments
 * @param {Record<string, { type: string }>} environments
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {string|null} [cliSource]
 * @returns {import('../deployment/deployment-env.js').SecretChecklistItem[]}
 */
export function getGithubSecretsChecklist(
  storageProviders,
  deployEnvironments,
  environments,
  config = null,
  cliSource = null
) {
  /** @type {Map<string, import('../deployment/deployment-env.js').SecretChecklistItem>} */
  const byKey = new Map();

  const resolvedCliSource = cliSource || config?.cli?.source;
  if (isGithubCliSource(resolvedCliSource)) {
    byKey.set(GITHUB_CLI_TOKEN_SECRET, {
      key: GITHUB_CLI_TOKEN_SECRET,
      required: true,
      note: 'required when installing DeployHub CLI from a private GitHub repo',
    });
  }

  for (const provider of storageProviders) {
    const keys = PROVIDER_ENV_MAP[provider] || [];
    for (const key of keys) {
      byKey.set(key, { key, required: true });
    }
  }

  for (const envName of deployEnvironments) {
    const env = environments[envName];
    const method = getEnvMethod(env);
    if (!method) continue;

    for (const item of getDeploymentSecretChecklistItemsForEnv(
      envName,
      method,
      config,
      environments
    )) {
      const existing = byKey.get(item.key);
      if (existing) {
        if (item.required && !existing.required) {
          byKey.set(item.key, item);
        }
        continue;
      }
      byKey.set(item.key, item);
    }
  }

  return Array.from(byKey.values());
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
    const method = getEnvMethod(env);
    if (!method) continue;

    const deploySection = generateDeploymentEnvSection(method, config, environments);
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
