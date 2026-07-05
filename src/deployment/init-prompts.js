import inquirer from 'inquirer';
import chalk from 'chalk';
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

/**
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {Record<string, unknown>|null} backendConfig
 */
export async function promptServerDeployment(projectName, projectType, backendConfig) {
  const isBackend = projectType === 'backend' || projectType === 'both';

  const base = await inquirer.prompt([
    {
      type: 'list',
      name: 'deployType',
      message: 'Deployment type:',
      choices: SERVER_DEPLOY_TYPES,
    },
    {
      type: 'input',
      name: 'envName',
      message: 'Environment name (e.g. production, staging):',
      default: 'production',
    },
  ]);

  const deployType = base.deployType;

  if (deployType === 'kubernetes') {
    return promptKubernetesDeployment(base, projectName, projectType);
  }

  if (deployType === 'docker') {
    return promptDockerDeployment(base, projectName, projectType);
  }

  return promptSshBasedDeployment(base, projectName, projectType, backendConfig, deployType);
}

/**
 * @param {Record<string, string>} base
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 */
async function promptKubernetesDeployment(base, projectName, projectType) {
  const defaultKubeconfig = await detectKubeconfigPath();
  const contexts = await listKubeContexts();

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
      message: 'Kubernetes namespace (e.g. my-app or default):',
      default: projectName,
    },
    {
      type: 'input',
      name: 'dockerImageName',
      message: 'Container image name (e.g. ghcr.io/myorg/myapp):',
      default: projectName,
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
    healthUrl: kubeAnswers.healthUrl,
  };
}

/**
 * @param {Record<string, string>} base
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 */
async function promptDockerDeployment(base, projectName, projectType) {
  const dockerAnswers = await inquirer.prompt([
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
    {
      type: 'input',
      name: 'dockerHost',
      message: 'Remote Docker host (optional, e.g. ssh://ubuntu@203.0.113.10):',
    },
    {
      type: 'input',
      name: 'healthUrl',
      message: 'Health check URL (optional):',
    },
  ]);

  return { ...base, ...dockerAnswers };
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
      message: `PM2 process name for your backend (e.g. ${projectName}-api):`,
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
  const envEntry = {
    deploymentType: 'server',
    type: deployAnswers.deployType,
  };

  if (deployAnswers.deployType === 'kubernetes') {
    envEntry.kubeconfig = deployAnswers.kubeconfig;
    envEntry.kubeContext = deployAnswers.kubeContext;
    envEntry.kubeNamespace = deployAnswers.kubeNamespace || projectName;
    envEntry.dockerImageName = deployAnswers.dockerImageName || projectName;
    return envEntry;
  }

  if (deployAnswers.deployType === 'docker') {
    envEntry.dockerImageName = deployAnswers.dockerImageName || projectName;
    envEntry.dockerRegistryUrl = deployAnswers.dockerRegistryUrl || '';
    envEntry.dockerHost = deployAnswers.dockerHost || '';
    return envEntry;
  }

  envEntry.host = deployAnswers.host || '';
  envEntry.user = deployAnswers.user || '';
  envEntry.keyPath = deployAnswers.keyPath || '';
  envEntry.sshPort = Number(deployAnswers.sshPort) || 22;

  if (deployAnswers.ec2InstanceId) envEntry.ec2InstanceId = deployAnswers.ec2InstanceId;
  if (deployAnswers.awsRegion) envEntry.awsRegion = deployAnswers.awsRegion;
  if (deployAnswers.azureSubscriptionId) envEntry.azureSubscriptionId = deployAnswers.azureSubscriptionId;
  if (deployAnswers.azureResourceGroup) envEntry.azureResourceGroup = deployAnswers.azureResourceGroup;
  if (deployAnswers.azureVmName) envEntry.azureVmName = deployAnswers.azureVmName;
  if (deployAnswers.gcpProjectId) envEntry.gcpProjectId = deployAnswers.gcpProjectId;
  if (deployAnswers.gcpZone) envEntry.gcpZone = deployAnswers.gcpZone;
  if (deployAnswers.gcpInstanceName) envEntry.gcpInstanceName = deployAnswers.gcpInstanceName;

  if (projectType === 'both') {
    envEntry.frontendDeployPath =
      deployAnswers.frontendDeployPath || `/var/www/${projectName}/public`;
    envEntry.backendDeployPath =
      deployAnswers.backendDeployPath || `/var/www/${projectName}/api`;
    envEntry.appName = deployAnswers.appName || `${projectName}-api`;
    envEntry.framework = backendConfig?.framework || 'express';
    envEntry.path = envEntry.backendDeployPath;
    envEntry.backendDeploymentType = 'server';
  } else if (projectType === 'backend') {
    envEntry.deployPath = deployAnswers.deployPath || `/var/www/${projectName}`;
    envEntry.path = envEntry.deployPath;
    envEntry.appName = deployAnswers.appName || projectName;
    envEntry.framework = singleConfig?.framework || 'express';
    envEntry.port = singleConfig?.port || 3000;
  } else {
    envEntry.deployPath = deployAnswers.deployPath || `/var/www/${projectName}`;
    envEntry.path = envEntry.deployPath;
  }

  return envEntry;
}

/**
 * @param {Awaited<ReturnType<typeof promptServerDeployment>>} deployAnswers
 * @returns {Record<string, string>|null}
 */
export function getDockerEnvSecrets(deployAnswers) {
  if (deployAnswers.deployType !== 'docker') return null;

  /** @type {Record<string, string>} */
  const vars = {};
  if (deployAnswers.dockerRegistryUsername) {
    vars.DOCKER_REGISTRY_USERNAME = deployAnswers.dockerRegistryUsername;
  }
  if (deployAnswers.dockerRegistryToken) {
    vars.DOCKER_REGISTRY_TOKEN = deployAnswers.dockerRegistryToken;
  }
  return Object.keys(vars).length > 0 ? vars : null;
}

export { SSH_BASED };
