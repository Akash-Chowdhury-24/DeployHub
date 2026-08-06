import { execa } from 'execa';
import { createSshProvider } from './ssh.js';
import { createLogger } from '../../logger/index.js';
import { getEnvSettings } from '../../core/config.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createAzureVmProvider(config, envName, env = process.env) {
  const log = createLogger('azure-vm');
  const settings = getEnvSettings(config.environments[envName]);
  const subscriptionId = env.AZURE_SUBSCRIPTION_ID || settings.azureSubscriptionId;
  const resourceGroup = env.AZURE_RESOURCE_GROUP || settings.azureResourceGroup;
  const vmName = env.AZURE_VM_NAME || settings.azureVmName;

  async function resolveHost() {
    if (settings.host || env.SSH_HOST) {
      return settings.host || env.SSH_HOST;
    }

    if (!subscriptionId || !resourceGroup || !vmName) {
      throw new Error(
        'Could not resolve host via Azure VM lookup, and no SSH_HOST was set — ' +
          'provide SSH_HOST (VM public IP/DNS) or set AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, and AZURE_VM_NAME for auto lookup.'
      );
    }

    log.info(`Looking up public IP for Azure VM ${vmName}...`);
    try {
      const { stdout } = await execa(
        'az',
        [
          'vm',
          'show',
          '-d',
          '-g',
          resourceGroup,
          '-n',
          vmName,
          '--subscription',
          subscriptionId,
          '--query',
          'publicIps',
          '-o',
          'tsv',
        ],
        { stdio: 'pipe' }
      );
      const publicIp = stdout.trim();
      if (!publicIp) {
        throw new Error('No public IP returned');
      }
      log.info(`Resolved Azure VM host: ${publicIp}`);
      return publicIp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not resolve host via Azure VM lookup (${vmName}): ${msg}. ` +
          'Set SSH_HOST to the VM public IP/DNS, or run az login and verify resource group/VM name.'
      );
    }
  }

  /**
   * Resolve host (skipping cloud lookup when SSH_HOST/environment.host is set),
   * then create an SSH provider that closes over the resolved host.
   */
  async function getSshProvider() {
    const host = await resolveHost();
    if (!host) {
      throw new Error(
        'Could not resolve host via Azure VM lookup, and no SSH_HOST was set — provide one or the other.'
      );
    }
    settings.host = host;
    return createSshProvider(config, envName, { ...env, SSH_HOST: host });
  }

  return {
    async connect() {
      const ssh = await getSshProvider();
      return ssh.connect();
    },
    async deploy(artifactDir, options) {
      const ssh = await getSshProvider();
      return ssh.deploy(artifactDir, options);
    },
    async rollback(artifactDir, meta) {
      const ssh = await getSshProvider();
      return ssh.rollback(artifactDir, meta);
    },
    async healthCheck() {
      const ssh = await getSshProvider();
      return ssh.healthCheck();
    },
    async testConnection() {
      const ssh = await getSshProvider();
      return ssh.testConnection();
    },
    async runRemoteCheck(command) {
      const ssh = await getSshProvider();
      return ssh.runRemoteCheck(command);
    },
  };
}

export default { createAzureVmProvider };
