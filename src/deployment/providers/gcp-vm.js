import { execa } from 'execa';
import { createSshProvider } from './ssh.js';
import { createLogger } from '../../logger/index.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createGcpVmProvider(config, envName, env = process.env) {
  const log = createLogger('gcp-vm');
  const projectId = env.GCP_PROJECT_ID;
  const zone = env.GCP_ZONE;
  const instanceName = env.GCP_INSTANCE_NAME;

  async function resolveHost() {
    const environment = config.environments[envName];
    if (environment?.host || env.SSH_HOST) {
      return environment?.host || env.SSH_HOST;
    }

    if (!projectId || !zone || !instanceName) {
      throw new Error(
        'GCP VM host unknown. Set SSH_HOST to your instance external IP, or set GCP_PROJECT_ID, GCP_ZONE, and GCP_INSTANCE_NAME for auto lookup.'
      );
    }

    log.info(`Looking up external IP for GCP instance ${instanceName}...`);

    /** @type {Record<string, string>} */
    const gcpEnv = { ...process.env };
    if (env.GCP_KEY_FILE) {
      gcpEnv.GOOGLE_APPLICATION_CREDENTIALS = env.GCP_KEY_FILE;
    }

    try {
      const { stdout } = await execa(
        'gcloud',
        [
          'compute',
          'instances',
          'describe',
          instanceName,
          '--zone',
          zone,
          '--project',
          projectId,
          '--format',
          'get(networkInterfaces[0].accessConfigs[0].natIP)',
        ],
        { stdio: 'pipe', env: gcpEnv }
      );
      const publicIp = stdout.trim();
      if (!publicIp) {
        throw new Error('No external IP returned');
      }
      log.info(`Resolved GCP VM host: ${publicIp}`);
      return publicIp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not resolve external IP for ${instanceName} — ${msg}. Set SSH_HOST manually or run gcloud auth login and verify project/zone/instance name.`
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

export default { createGcpVmProvider };
