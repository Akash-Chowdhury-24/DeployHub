import inquirer from 'inquirer';
import chalk from 'chalk';
import { createEnvNamePromptValidate, normalizeGitBranchName } from '../core/environments.js';
import {
  suggestSshUser,
  listKubeContexts,
  detectKubeconfigPath,
  detectAzureSubscriptionId,
  detectGcpProjectId,
  runSshInitValidation,
  resolveDeployPathsWithSpaceWarning,
  testKubeConnectivity,
  getDeployTypeLabel,
} from './init-helpers.js';

export const SERVER_DEPLOY_TYPES = [
  { name: 'SSH — any Linux server you already have', value: 'ssh' },
  { name: 'Docker — containerized app (local or remote daemon)', value: 'docker' },
  { name: 'AWS EC2 — SSH to an existing EC2 instance', value: 'ec2' },
  { name: 'Azure VM — SSH to an existing Azure virtual machine', value: 'azure-vm' },
  { name: 'GCP VM — SSH to an existing Compute Engine instance', value: 'gcp-vm' },
  { name: 'Kubernetes — deploy to an existing cluster', value: 'kubernetes' },
];

const SSH_BASED = ['ssh', 'ec2', 'azure-vm', 'gcp-vm'];

const NODE_PM2_FRAMEWORKS = new Set([
  'express',
  'nestjs',
  'fastify',
  'koa',
  'nextjs',
  'node',
]);

/**
 * User-facing label for the backend process identity field (`appName`).
 * Node backends use PM2; other languages use DEPLOYHUB_APP + PID files.
 *
 * @param {string|undefined|null} framework
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 * @returns {string}
 */
export function backendProcessNamePromptMessage(framework, projectName, projectType) {
  const backendFramework = String(framework || '').toLowerCase();
  const usesPm2 = !backendFramework || NODE_PM2_FRAMEWORKS.has(backendFramework);
  const example = projectType === 'both' ? `${projectName}-api` : projectName;
  return usesPm2
    ? `PM2 process name for your backend (e.g. ${example}):`
    : `Process name for your backend (identifies this app's process on the server, e.g. ${example}):`;
}
/**
 * Prompt for one environment's deployment method + method-specific config.
 * Shared by `deployhub init` and `deployhub env add`.
 *
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {Record<string, unknown>|null} backendConfig
 * @param {{
 *   envName?: string,
 *   existingEnvNames?: string[],
 *   deployType?: string,
 *   nonInteractive?: boolean,
 *   portDefault?: number,
 *   defaultTrigger?: 'push'|'manual',
 *   defaultBranch?: string,
 * }} [options]
 *   — when envName is set, skip the name prompt; existingEnvNames blocks in-session / config duplicates
 *   — deployType skips the method list; nonInteractive uses defaults (requires deployType)
 *   — portDefault seeds the docker "Default port" prompt (init / env add)
 *   — defaultTrigger / defaultBranch seed the trigger-type and branch prompts
 */
export async function promptServerDeployment(
  projectName,
  projectType,
  backendConfig,
  options = {}
) {
  const existingEnvNames = options.existingEnvNames || [];
  const allowedMethods = new Set(SERVER_DEPLOY_TYPES.map((c) => c.value));

  if (options.nonInteractive) {
    if (!options.deployType || !allowedMethods.has(options.deployType)) {
      throw new Error(
        'Non-interactive env add requires --method <ssh|docker|ec2|azure-vm|gcp-vm|kubernetes>.'
      );
    }
    return buildNonInteractiveDeployAnswers(
      options.deployType,
      projectName,
      options.envName,
      existingEnvNames
    );
  }

  /** @type {import('inquirer').QuestionCollection} */
  const questions = [];

  if (!options.deployType) {
    questions.push({
      type: 'list',
      name: 'deployType',
      message: 'Deployment type:',
      choices: SERVER_DEPLOY_TYPES,
    });
  } else if (!allowedMethods.has(options.deployType)) {
    throw new Error(
      `Unknown deployment method "${options.deployType}". Use: ${[...allowedMethods].join(', ')}`
    );
  }

  if (!options.envName) {
    questions.push({
      type: 'input',
      name: 'envName',
      message: 'Environment name (e.g. production, staging):',
      default: 'production',
      validate: createEnvNamePromptValidate(existingEnvNames),
    });
  }

  const base =
    questions.length > 0 ? await inquirer.prompt(questions) : {};
  if (options.envName) {
    base.envName = options.envName;
  }
  if (options.deployType) {
    base.deployType = options.deployType;
  }

  const deployType = base.deployType;

  /** @type {Record<string, unknown>} */
  let methodAnswers;
  if (deployType === 'kubernetes') {
    methodAnswers = await promptKubernetesDeployment(base, projectName, projectType, {
      existingEnvNames,
    });
  } else if (deployType === 'docker') {
    methodAnswers = await promptDockerDeployment(base, projectName, projectType, {
      backendConfig,
      portDefault: options.portDefault,
    });
  } else {
    methodAnswers = await promptSshBasedDeployment(
      base,
      projectName,
      projectType,
      backendConfig,
      deployType
    );
  }

  const triggerMeta = await promptTriggerAndBranch(options);
  const hookMeta = await promptDeployHooksIfSupported(deployType, methodAnswers);
  return { ...methodAnswers, ...triggerMeta, ...hookMeta };
}

/**
 * Optional pre/post/rollback commands. Skipped unless the method has a
 * DeployHub-managed SSH session (ssh / ec2 / azure-vm / gcp-vm / docker-ssh).
 *
 * @param {string} deployType
 * @param {Record<string, unknown>} methodAnswers
 */
async function promptDeployHooksIfSupported(deployType, methodAnswers) {
  const sshBased = SSH_BASED.includes(deployType);
  const dockerSsh = deployType === 'docker' && methodAnswers.remoteMode === 'ssh';
  if (!sshBased && !dockerSsh) {
    return {};
  }
  return promptDeployHooks();
}

/**
 * @returns {Promise<{ hooks?: Record<string, { command: string, continueOnError: boolean }[]> }>}
 */
export async function promptDeployHooks() {
  /** @type {Record<string, { command: string, continueOnError: boolean }[]>} */
  const hooks = {};

  const { addPreDeploy } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'addPreDeploy',
      message: 'Add a pre-deploy command? (e.g. run migrations)',
      default: false,
    },
  ]);
  if (addPreDeploy) {
    const { command, abortOnFailure } = await inquirer.prompt([
      {
        type: 'input',
        name: 'command',
        message: 'Pre-deploy command:',
        validate: (input) =>
          String(input || '').trim() ? true : 'Enter a command to run on the remote host.',
      },
      {
        type: 'confirm',
        name: 'abortOnFailure',
        message: 'Should a failure abort the deploy?',
        default: true,
      },
    ]);
    hooks.preDeploy = [
      {
        command: String(command).trim(),
        continueOnError: abortOnFailure === false,
      },
    ];
  }

  const { addPostDeploy } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'addPostDeploy',
      message: 'Add a post-deploy command? (e.g. clear cache, notify)',
      default: false,
    },
  ]);
  if (addPostDeploy) {
    const { command, abortOnFailure } = await inquirer.prompt([
      {
        type: 'input',
        name: 'command',
        message: 'Post-deploy command:',
        validate: (input) =>
          String(input || '').trim() ? true : 'Enter a command to run on the remote host.',
      },
      {
        type: 'confirm',
        name: 'abortOnFailure',
        message: 'Should a failure abort the deploy?',
        default: false,
      },
    ]);
    hooks.postDeploy = [
      {
        command: String(command).trim(),
        continueOnError: abortOnFailure !== true,
      },
    ];
  }

  const { addRollback } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'addRollback',
      message: 'Add a rollback command? (e.g. reverse migration)',
      default: false,
    },
  ]);
  if (addRollback) {
    const { command, abortOnFailure } = await inquirer.prompt([
      {
        type: 'input',
        name: 'command',
        message: 'Rollback command:',
        validate: (input) =>
          String(input || '').trim() ? true : 'Enter a command to run on the remote host.',
      },
      {
        type: 'confirm',
        name: 'abortOnFailure',
        message: 'Should a failure abort the rollback?',
        default: true,
      },
    ]);
    hooks.rollback = [
      {
        command: String(command).trim(),
        continueOnError: abortOnFailure === false,
      },
    ];
  }

  return Object.keys(hooks).length > 0 ? { hooks } : {};
}

/**
 * Trigger type + (when push) which branch fires this environment.
 * `--yes` skips this entirely so existing non-interactive env add stays branch-less.
 *
 * @param {{ defaultTrigger?: 'push'|'manual', defaultBranch?: string }} [options]
 */
export async function promptTriggerAndBranch(options = {}) {
  const defaultTrigger = options.defaultTrigger === 'push' ? 'push' : 'manual';
  const defaultBranch =
    typeof options.defaultBranch === 'string' && options.defaultBranch.trim()
      ? options.defaultBranch.trim()
      : 'main';

  const { trigger } = await inquirer.prompt([
    {
      type: 'list',
      name: 'trigger',
      message: 'When should this environment deploy?',
      choices: [
        { name: 'On git push to a branch', value: 'push' },
        { name: 'Manually (GitHub Actions → Run workflow)', value: 'manual' },
      ],
      default: defaultTrigger,
    },
  ]);

  if (trigger !== 'push') {
    return { trigger: 'manual' };
  }

  const { branch } = await inquirer.prompt([
    {
      type: 'input',
      name: 'branch',
      message: 'Which branch triggers this environment?',
      default: defaultBranch,
      validate: (input) => {
        const result = normalizeGitBranchName(input);
        return result.ok ? true : result.error;
      },
    },
  ]);

  const parsed = normalizeGitBranchName(branch);
  return {
    trigger: 'push',
    branch: parsed.ok ? parsed.name : defaultBranch,
  };
}

/**
 * Defaults for `deployhub env add <name> --method <type> --yes` (no prompts).
 * @param {string} deployType
 * @param {string} projectName
 * @param {string} [envName]
 * @param {string[]} [existingEnvNames]
 */
function buildNonInteractiveDeployAnswers(
  deployType,
  projectName,
  envName,
  existingEnvNames = []
) {
  const base = { deployType, envName: envName || 'default' };
  if (deployType === 'docker') {
    return {
      ...base,
      dockerImageName: projectName,
      dockerRegistryUrl: '',
      dockerRegistryUsername: '',
      dockerRegistryToken: '',
      dockerHost: '',
      remoteMode: 'local',
      healthUrl: '',
    };
  }
  if (deployType === 'kubernetes') {
    return {
      ...base,
      kubeconfig: '~/.kube/config',
      kubeContext: '',
      kubeNamespace: suggestKubeNamespaceDefault(
        projectName,
        base.envName,
        existingEnvNames
      ),
      dockerImageName: projectName,
      dockerRegistryUrl: '',
      dockerRegistryUsername: '',
      dockerRegistryToken: '',
      healthUrl: '',
    };
  }
  // ssh / ec2 / azure-vm / gcp-vm — host/user left empty (filled via secrets / env)
  return {
    ...base,
    host: '',
    user: 'deploy',
    keyPath: '',
    sshPort: '22',
    deployPath: `/var/www/${projectName}`,
    osHint: '',
  };
}

/**
 * Suggested Kubernetes namespace for prompts / --yes defaults.
 * First environment → bare project name; additional envs → `{project}-{envName}`
 * so the suggested default matches resolveKubeNamespace auto-scoping behavior.
 *
 * @param {string} projectName
 * @param {string} envName
 * @param {string[]} existingEnvNames
 * @returns {string}
 */
export function suggestKubeNamespaceDefault(projectName, envName, existingEnvNames = []) {
  if ((existingEnvNames || []).length > 0) {
    return `${projectName}-${envName}`;
  }
  return projectName;
}

/**
 * @param {Record<string, string>} base
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {{ existingEnvNames?: string[] }} [options]
 */
async function promptKubernetesDeployment(base, projectName, projectType, options = {}) {
  const defaultKubeconfig = await detectKubeconfigPath();
  const contexts = await listKubeContexts();
  const envName = base.envName || 'production';
  const existingEnvNames = options.existingEnvNames || [];
  const namespaceDefault = suggestKubeNamespaceDefault(
    projectName,
    envName,
    existingEnvNames
  );

  const kubeAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'kubeconfig',
      message: 'Path to kubeconfig file (e.g. ~/.kube/config):',
      default: defaultKubeconfig || '~/.kube/config',
    },
    {
      type: contexts.length > 0 ? 'list' : 'input',
      name: 'kubeContext',
      message: 'Kubernetes context to deploy into:',
      choices: contexts.length > 0 ? contexts : undefined,
      default: contexts[0],
    },
    {
      type: 'input',
      name: 'kubeNamespace',
      message:
        existingEnvNames.length > 0
          ? `Kubernetes namespace (suggested ${namespaceDefault} so it does not collide with existing envs):`
          : 'Kubernetes namespace (e.g. my-app or default):',
      default: namespaceDefault,
    },
    {
      type: 'input',
      name: 'dockerImageName',
      message: 'Container image name (e.g. ghcr.io/myorg/myapp):',
      default: projectName,
    },
    {
      type: 'input',
      name: 'dockerRegistryUrl',
      message: 'Registry URL (leave empty for Docker Hub):',
    },
    {
      type: 'input',
      name: 'dockerRegistryUsername',
      message:
        'Registry username (required — needed to push your image so the cluster can pull it):',
    },
    {
      type: 'password',
      name: 'dockerRegistryToken',
      message:
        'Registry token/password (required — needed to push your image so the cluster can pull it):',
    },
    {
      type: 'input',
      name: 'healthUrl',
      message: 'Health check URL (optional, e.g. https://myapp.example.com/health):',
    },
  ]);

  console.log(chalk.gray('\n  Testing Kubernetes connectivity...'));
  const kubeTest = await testKubeConnectivity(kubeAnswers.kubeconfig, kubeAnswers.kubeContext);
  if (kubeTest.ok) {
    console.log(chalk.green(`  ✓ ${kubeTest.message}`));
  } else {
    console.log(chalk.yellow(`  ⚠ ${kubeTest.message}`));
  }

  return {
    ...base,
    kubeconfig: kubeAnswers.kubeconfig,
    kubeContext: kubeAnswers.kubeContext,
    kubeNamespace: kubeAnswers.kubeNamespace,
    dockerImageName: kubeAnswers.dockerImageName,
    dockerRegistryUrl: kubeAnswers.dockerRegistryUrl,
    dockerRegistryUsername: kubeAnswers.dockerRegistryUsername,
    dockerRegistryToken: kubeAnswers.dockerRegistryToken,
    healthUrl: kubeAnswers.healthUrl,
  };
}

/**
 * @param {Record<string, string>} base
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {{
 *   backendConfig?: Record<string, unknown>|null,
 *   portDefault?: number,
 * }} [options]
 */
async function promptDockerDeployment(base, projectName, projectType, options = {}) {
  const imageAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'dockerImageName',
      message: 'Docker image name (e.g. myorg/myapp or ghcr.io/myorg/myapp):',
      default: projectName,
    },
    {
      type: 'input',
      name: 'dockerRegistryUrl',
      message: 'Registry URL (leave empty for Docker Hub):',
    },
    {
      type: 'input',
      name: 'dockerRegistryUsername',
      message: 'Registry username (only if using a private registry):',
    },
    {
      type: 'password',
      name: 'dockerRegistryToken',
      message: 'Registry token/password (only if using a private registry):',
    },
  ]);

  const { remoteMode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'remoteMode',
      message: 'Where should the container run?',
      choices: [
        { name: 'Locally (this machine or CI runner)', value: 'local' },
        {
          name: 'Remote Linux server via SSH (recommended for production)',
          value: 'ssh',
        },
        {
          name: 'Advanced: raw Docker host URI (tcp://, custom SSH setup)',
          value: 'raw',
        },
      ],
      default: 'local',
    },
  ]);

  /** @type {Record<string, string>} */
  let sshAnswers = {};
  /** @type {Record<string, string>} */
  let rawAnswers = {};

  if (remoteMode === 'ssh') {
    sshAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'host',
        message: 'Remote server host/IP:',
      },
      {
        type: 'input',
        name: 'user',
        message: 'SSH username:',
      },
      {
        type: 'input',
        name: 'keyPath',
        message: 'Path to SSH private key:',
      },
    ]);

    await runSshInitValidation({
      host: sshAnswers.host,
      user: sshAnswers.user,
      keyPath: sshAnswers.keyPath,
      sshPort: 22,
      deployType: getDeployTypeLabel('docker'),
    });
  }

  if (remoteMode === 'raw') {
    console.log(
      chalk.gray(
        '\n  Note: this mode uses Docker\'s native ssh://tcp:// transport and\n' +
          '  depends on your local machine\'s own SSH/TLS configuration —\n' +
          '  DeployHub cannot validate this connection ahead of time. Prefer\n' +
          '  "Remote Linux server via SSH" above unless you have a specific\n' +
          '  reason to use this.\n'
      )
    );
    rawAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'dockerHost',
        message: 'Remote Docker host (optional, e.g. ssh://ubuntu@203.0.113.10):',
      },
    ]);
  }

  const portDefaultRaw = options.portDefault ?? options.backendConfig?.port;
  const portDefault = Number.isInteger(Number(portDefaultRaw))
    ? Number(portDefaultRaw)
    : 3000;

  const { port, healthUrl } = await inquirer.prompt([
    {
      type: 'number',
      name: 'port',
      message: 'Default port:',
      default: portDefault,
      validate: (value) => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return 'Enter a port number between 1 and 65535.';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'healthUrl',
      message: 'Health check URL (optional):',
    },
  ]);

  return {
    ...base,
    ...imageAnswers,
    remoteMode,
    ...sshAnswers,
    dockerHost: rawAnswers.dockerHost || '',
    port,
    healthUrl,
  };
}

/**
 * @param {Record<string, string>} base
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {Record<string, unknown>|null} backendConfig
 * @param {string} deployType
 */
async function promptSshBasedDeployment(base, projectName, projectType, backendConfig, deployType) {
  const isBackend = projectType === 'backend' || projectType === 'both';

  let detectedSubscription;
  let detectedProject;
  if (deployType === 'azure-vm') {
    detectedSubscription = await detectAzureSubscriptionId();
    if (detectedSubscription) {
      console.log(chalk.gray(`  Detected Azure subscription: ${detectedSubscription}`));
    }
  }
  if (deployType === 'gcp-vm') {
    detectedProject = await detectGcpProjectId();
    if (detectedProject) {
      console.log(chalk.gray(`  Detected GCP project: ${detectedProject}`));
    }
  }

  /** @type {import('inquirer').QuestionCollection} */
  const questions = [
    {
      type: 'input',
      name: 'host',
      message:
        deployType === 'ec2'
          ? 'EC2 public IP or DNS (e.g. 54.123.45.67 or ec2-xx.compute.amazonaws.com):'
          : deployType === 'azure-vm'
            ? 'Azure VM public IP or DNS (e.g. 20.1.2.3):'
            : deployType === 'gcp-vm'
              ? 'GCP VM external IP (e.g. 34.56.78.90):'
              : 'Server IP or hostname (e.g. 203.0.113.10 or myserver.example.com):',
      when: () => true,
    },
    {
      type: 'input',
      name: 'osHint',
      message: 'Server OS image hint (e.g. Ubuntu, Amazon Linux) — used to suggest SSH user:',
      when: () => ['ec2', 'azure-vm', 'gcp-vm', 'ssh'].includes(deployType),
    },
    {
      type: 'input',
      name: 'user',
      message: 'SSH username (e.g. ubuntu for Ubuntu, ec2-user for Amazon Linux):',
      default: (a) => suggestSshUser(a.osHint) || (deployType === 'ec2' ? 'ubuntu' : 'deploy'),
    },
    {
      type: 'input',
      name: 'keyPath',
      message: 'Path to SSH private key file (e.g. ~/.ssh/my-key.pem):',
    },
    {
      type: 'input',
      name: 'sshPort',
      message: 'SSH port (default 22):',
      default: '22',
    },
  ];

  if (deployType === 'ec2') {
    questions.push(
      {
        type: 'input',
        name: 'ec2InstanceId',
        message: 'EC2 instance ID for auto IP lookup (optional, e.g. i-0abc123def4567890):',
      },
      {
        type: 'input',
        name: 'awsRegion',
        message: 'AWS region (e.g. us-east-1):',
        default: 'us-east-1',
        when: (a) => !!a.ec2InstanceId,
      }
    );
  }

  if (deployType === 'azure-vm') {
    questions.push(
      {
        type: 'input',
        name: 'azureSubscriptionId',
        message: 'Azure subscription ID (optional, for auto IP lookup):',
        default: detectedSubscription || '',
      },
      {
        type: 'input',
        name: 'azureResourceGroup',
        message: 'Azure resource group name (optional, e.g. my-app-rg):',
      },
      {
        type: 'input',
        name: 'azureVmName',
        message: 'Azure VM name (optional, for auto IP lookup):',
      }
    );
  }

  if (deployType === 'gcp-vm') {
    questions.push(
      {
        type: 'input',
        name: 'gcpProjectId',
        message: 'GCP project ID (optional, for auto IP lookup):',
        default: detectedProject || '',
      },
      {
        type: 'input',
        name: 'gcpZone',
        message: 'GCP zone (optional, e.g. us-central1-a):',
      },
      {
        type: 'input',
        name: 'gcpInstanceName',
        message: 'GCP instance name (optional, for auto IP lookup):',
      }
    );
  }

  if (projectType !== 'both') {
    questions.push({
      type: 'input',
      name: 'deployPath',
      message: `Remote deploy directory (e.g. /var/www/${projectName}):`,
      default: `/var/www/${projectName}`,
    });
  }

  if (projectType === 'both') {
    questions.push(
      {
        type: 'input',
        name: 'frontendDeployPath',
        message: `Frontend deploy path (e.g. /var/www/${projectName}/public):`,
        default: `/var/www/${projectName}/public`,
      },
      {
        type: 'input',
        name: 'backendDeployPath',
        message: `Backend deploy path (e.g. /var/www/${projectName}/api):`,
        default: `/var/www/${projectName}/api`,
      }
    );
  }

  if (isBackend) {
    questions.push({
      type: 'input',
      name: 'appName',
      message: backendProcessNamePromptMessage(
        /** @type {string|undefined} */ (backendConfig?.framework),
        projectName,
        projectType
      ),
      default: projectType === 'both' ? `${projectName}-api` : projectName,
    });
  }

  questions.push({
    type: 'input',
    name: 'healthUrl',
    message: 'Health check URL (optional, e.g. https://api.example.com/health):',
  });

  const sshAnswers = await inquirer.prompt(questions);
  await resolveDeployPathsWithSpaceWarning(sshAnswers, projectType);

  await runSshInitValidation({
    host: sshAnswers.host,
    user: sshAnswers.user,
    keyPath: sshAnswers.keyPath,
    sshPort: Number(sshAnswers.sshPort) || 22,
    deployType: getDeployTypeLabel(deployType),
  });

  return { ...base, ...sshAnswers };
}

/**
 * @param {Awaited<ReturnType<typeof promptServerDeployment>>} deployAnswers
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {string} projectName
 * @param {Record<string, unknown>|null} backendConfig
 * @param {Record<string, unknown>|null} singleConfig
 */
export function buildServerEnvEntry(
  deployAnswers,
  projectType,
  projectName,
  backendConfig,
  singleConfig
) {
  /** @type {Record<string, unknown>} */
  const settings = {
    deploymentType: 'server',
  };

  if (deployAnswers.deployType === 'kubernetes') {
    settings.kubeconfig = deployAnswers.kubeconfig;
    settings.kubeContext = deployAnswers.kubeContext;
    settings.kubeNamespace = deployAnswers.kubeNamespace || projectName;
    settings.dockerImageName = deployAnswers.dockerImageName || projectName;
    settings.dockerRegistryUrl = deployAnswers.dockerRegistryUrl || '';
    return withTriggerAndBranch(
      {
        enabled: true,
        method: 'kubernetes',
        trigger: 'manual',
        config: settings,
      },
      deployAnswers
    );
  }

  if (deployAnswers.deployType === 'docker') {
    settings.dockerImageName = deployAnswers.dockerImageName || projectName;
    settings.dockerRegistryUrl = deployAnswers.dockerRegistryUrl || '';
    const remoteMode =
      deployAnswers.remoteMode || (deployAnswers.dockerHost ? 'raw' : 'local');
    settings.remote = { mode: remoteMode };
    // Raw URI stays in config (existing DOCKER_HOST overlay). SSH key path is
    // env-only. Host/user are non-secret settings (same as ec2) so doctor and
    // .env.example can resolve them without writing the private key path here.
    settings.dockerHost = remoteMode === 'raw' ? deployAnswers.dockerHost || '' : '';
    if (remoteMode === 'ssh') {
      if (deployAnswers.host) settings.host = deployAnswers.host;
      if (deployAnswers.user) settings.user = deployAnswers.user;
    }
    // Per-env port (same key resolveDockerPublishPort reads). Prefer the
    // docker "Default port" answer; fall back to init's project-level port.
    // Do not invent || 3000 — missing port must stay missing so SSH deploy
    // fails loudly instead of publishing a sibling environment's port.
    const rawPort = deployAnswers.port ?? singleConfig?.port;
    const n = Number(rawPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) {
      settings.port = n;
    }
    attachHooksFromAnswers(settings, deployAnswers);
    return withTriggerAndBranch(
      {
        enabled: true,
        method: 'docker',
        trigger: 'manual',
        config: settings,
      },
      deployAnswers
    );
  }

  settings.host = deployAnswers.host || '';
  settings.user = deployAnswers.user || '';
  settings.keyPath = deployAnswers.keyPath || '';
  settings.sshPort = Number(deployAnswers.sshPort) || 22;

  if (deployAnswers.ec2InstanceId) settings.ec2InstanceId = deployAnswers.ec2InstanceId;
  if (deployAnswers.awsRegion) settings.awsRegion = deployAnswers.awsRegion;
  if (deployAnswers.azureSubscriptionId) settings.azureSubscriptionId = deployAnswers.azureSubscriptionId;
  if (deployAnswers.azureResourceGroup) settings.azureResourceGroup = deployAnswers.azureResourceGroup;
  if (deployAnswers.azureVmName) settings.azureVmName = deployAnswers.azureVmName;
  if (deployAnswers.gcpProjectId) settings.gcpProjectId = deployAnswers.gcpProjectId;
  if (deployAnswers.gcpZone) settings.gcpZone = deployAnswers.gcpZone;
  if (deployAnswers.gcpInstanceName) settings.gcpInstanceName = deployAnswers.gcpInstanceName;

  if (projectType === 'both') {
    settings.frontendDeployPath =
      deployAnswers.frontendDeployPath || `/var/www/${projectName}/public`;
    settings.backendDeployPath =
      deployAnswers.backendDeployPath || `/var/www/${projectName}/api`;
    settings.appName = deployAnswers.appName || `${projectName}-api`;
    settings.framework = backendConfig?.framework || 'express';
    settings.path = settings.backendDeployPath;
    settings.backendDeploymentType = 'server';
  } else if (projectType === 'backend') {
    settings.deployPath = deployAnswers.deployPath || `/var/www/${projectName}`;
    settings.path = settings.deployPath;
    settings.appName = deployAnswers.appName || projectName;
    settings.framework = singleConfig?.framework || 'express';
    settings.port = singleConfig?.port || 3000;
  } else {
    settings.deployPath = deployAnswers.deployPath || `/var/www/${projectName}`;
    settings.path = settings.deployPath;
  }

  attachHooksFromAnswers(settings, deployAnswers);
  return withTriggerAndBranch(
    {
      enabled: true,
      method: deployAnswers.deployType,
      trigger: 'manual',
      config: settings,
    },
    deployAnswers
  );
}

/**
 * Copy optional hook answers onto the env method config.
 * @param {Record<string, unknown>} settings
 * @param {Record<string, unknown>} deployAnswers
 */
function attachHooksFromAnswers(settings, deployAnswers) {
  const raw = deployAnswers && deployAnswers.hooks;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const hooks = /** @type {Record<string, unknown>} */ (raw);
  if (hooks.preDeploy || hooks.postDeploy || hooks.rollback) {
    settings.hooks = hooks;
  }
}

/**
 * Overlay prompt answers onto the env entry. `--yes` / missing answers keep
 * trigger `manual` and omit `branch` (backward compatible).
 *
 * @param {{ enabled: boolean, method: string, trigger: string, config: Record<string, unknown>, branch?: string }} entry
 * @param {Record<string, unknown>} deployAnswers
 */
function withTriggerAndBranch(entry, deployAnswers) {
  const trigger = deployAnswers.trigger === 'push' ? 'push' : 'manual';
  entry.trigger = trigger;
  if (trigger === 'push' && deployAnswers.branch != null) {
    const parsed = normalizeGitBranchName(deployAnswers.branch);
    if (parsed.ok) entry.branch = parsed.name;
  } else {
    delete entry.branch;
  }
  return entry;
}

/**
 * Apply init-time trigger defaults after environments are collected.
 * - Exactly one env → always `push` (git push = auto-deploy).
 * - Two or more → grandfathered/default gets `push`; all others stay `manual`.
 *
 * @param {Record<string, { trigger?: string }>} environments
 * @param {string[]} deployNames
 * @param {string|undefined|null} defaultEnvironment
 */
export function applyInitTriggerDefaults(environments, deployNames, defaultEnvironment) {
  if (deployNames.length === 1 && environments[deployNames[0]]) {
    environments[deployNames[0]].trigger = 'push';
    return;
  }
  if (deployNames.length >= 2 && defaultEnvironment) {
    for (const name of deployNames) {
      if (!environments[name]) continue;
      environments[name].trigger =
        name === defaultEnvironment ? 'push' : 'manual';
    }
  }
}

/**
 * End-of-init reminder for multi-env setups (grandfathered = push, others = manual).
 * @param {string} grandfathered
 * @param {string[]} allEnvNames
 * @returns {string}
 */
export function formatMultiEnvTriggerReminder(grandfathered, allEnvNames) {
  const others = allEnvNames.filter((n) => n !== grandfathered);
  const otherList =
    others.length > 0 ? others.map((n) => `"${n}"`).join(', ') : '(none)';
  const exampleEnv = others[0] || '<env-name>';
  return [
    '─────────────────────────────────────────────',
    `By default, only your first environment ("${grandfathered}")`,
    `auto-deploys on push. Your other environment(s) — ${otherList} — are set to manual and will only deploy via:`,
    '  deployhub deploy --env <name>',
    'or GitHub Actions → Run workflow.',
    '',
    'To make an environment auto-deploy on push instead, open',
    'deployhub.config.json and change its "trigger" to "push":',
    '  "environments": {',
    `    "${exampleEnv}": { "trigger": "push", ... }`,
    '  }',
    'Then run: deployhub sync-workflows',
    '─────────────────────────────────────────────',
  ].join('\n');
}

/**
 * @param {Awaited<ReturnType<typeof promptServerDeployment>>} deployAnswers
 * @returns {Record<string, string>|null}
 */
export function getDockerEnvSecrets(deployAnswers) {
  if (!['docker', 'kubernetes'].includes(deployAnswers.deployType)) return null;

  /** @type {Record<string, string>} */
  const vars = {};
  if (deployAnswers.dockerRegistryUsername) {
    vars.DOCKER_REGISTRY_USERNAME = deployAnswers.dockerRegistryUsername;
  }
  if (deployAnswers.dockerRegistryToken) {
    vars.DOCKER_REGISTRY_TOKEN = deployAnswers.dockerRegistryToken;
  }
  if (deployAnswers.deployType === 'docker' && deployAnswers.remoteMode === 'ssh') {
    if (deployAnswers.keyPath) vars.SSH_KEY_PATH = deployAnswers.keyPath;
  }
  if (deployAnswers.deployType === 'docker' && deployAnswers.remoteMode === 'raw') {
    if (deployAnswers.dockerHost) vars.DOCKER_HOST = deployAnswers.dockerHost;
  }
  return Object.keys(vars).length > 0 ? vars : null;
}

export { SSH_BASED };
