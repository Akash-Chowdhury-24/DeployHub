import { execa } from 'execa';
import { createSshProvider } from './ssh.js';
import { createLogger } from '../../logger/index.js';
import { getEnvSettings } from '../../core/config.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createEc2Provider(config, envName, env = process.env) {
  const log = createLogger('ec2');
  const settings = getEnvSettings(config.environments[envName]);
  const instanceId = env.EC2_INSTANCE_ID || settings.ec2InstanceId;
  const region = env.AWS_REGION || settings.awsRegion || 'us-east-1';

  async function resolveHost() {
    if (settings.host || env.SSH_HOST) {
      return settings.host || env.SSH_HOST;
    }

    if (!instanceId) {
      throw new Error(
        'Could not resolve host via EC2 instance lookup, and no SSH_HOST was set — ' +
          'provide SSH_HOST (instance public IP/DNS) or set EC2_INSTANCE_ID with AWS credentials for auto lookup.'
      );
    }

    log.info(`Looking up public IP for instance ${instanceId}...`);

    /** @type {Record<string, string>} */
    const awsEnv = { ...process.env };
    if (env.AWS_ACCESS_KEY_ID) awsEnv.AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID;
    if (env.AWS_SECRET_ACCESS_KEY) awsEnv.AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
    awsEnv.AWS_DEFAULT_REGION = region;

    try {
      const { stdout } = await execa(
        'aws',
        [
          'ec2',
          'describe-instances',
          '--instance-ids',
          instanceId,
          '--query',
          'Reservations[0].Instances[0].PublicIpAddress',
          '--output',
          'text',
          '--region',
          region,
        ],
        { stdio: 'pipe', env: awsEnv }
      );
      const publicIp = stdout.trim();
      if (!publicIp || publicIp === 'None') {
        throw new Error('No public IP returned');
      }
      log.info(`Resolved EC2 host: ${publicIp}`);
      return publicIp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not resolve host via EC2 instance lookup (${instanceId}): ${msg}. ` +
          'Set SSH_HOST to the instance public IP/DNS, or fix AWS CLI credentials / ec2:DescribeInstances access.'
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
        'Could not resolve host via EC2 instance lookup, and no SSH_HOST was set — provide one or the other.'
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

export default { createEc2Provider };
