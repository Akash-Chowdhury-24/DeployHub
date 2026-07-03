import { execa } from 'execa';
import { createSshProvider } from './ssh.js';
import { createLogger } from '../../logger/index.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createAzureVmProvider(config, envName, env = process.env) {
  const log = createLogger('azure-vm');
  const subscriptionId = env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = env.AZURE_RESOURCE_GROUP;
  const vmName = env.AZURE_VM_NAME;

  async function resolveHost() {
    const environment = config.environments[envName];
    if (environment?.host || env.SSH_HOST) {
      return environment?.host || env.SSH_HOST;
    }

    if (!subscriptionId || !resourceGroup || !vmName) {
      throw new Error(
        'Azure VM host unknown. Set SSH_HOST to your VM public IP, or set AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, and AZURE_VM_NAME for auto lookup.'
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
        `Could not resolve public IP for VM ${vmName} — ${msg}. Set SSH_HOST manually or run az login and verify resource group/VM name.`
      );
    }
  }

  const sshProvider = createSshProvider(config, envName, env);

  async function connect() {
    const host = await resolveHost();
    const environment = config.environments[envName];
    if (environment && !environment.host) {
      environment.host = host;
    }
    if (!env.SSH_HOST) {
      env.SSH_HOST = host;
    }
    return sshProvider.connect();
  }

  return {
    ...sshProvider,
    connect,
    deploy: sshProvider.deploy.bind(sshProvider),
    rollback: sshProvider.rollback.bind(sshProvider),
    healthCheck: sshProvider.healthCheck.bind(sshProvider),
    testConnection: async () => {
      const ssh = await connect();
      ssh.dispose();
    },
  };
}

export default { createAzureVmProvider };
