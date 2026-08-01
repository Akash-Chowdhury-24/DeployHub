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
        'Could not resolve host via GCP instance lookup, and no SSH_HOST was set — ' +
          'provide SSH_HOST (instance external IP/DNS) or set GCP_PROJECT_ID, GCP_ZONE, and GCP_INSTANCE_NAME for auto lookup.'
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
        `Could not resolve host via GCP instance lookup (${instanceName}): ${msg}. ` +
          'Set SSH_HOST to the instance external IP/DNS, or run gcloud auth login and verify project/zone/instance name.'
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
        'Could not resolve host via GCP instance lookup, and no SSH_HOST was set — provide one or the other.'
      );
    }
    const environment = config.environments[envName];
    if (environment) {
      environment.host = host;
    }
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

export default { createGcpVmProvider };
