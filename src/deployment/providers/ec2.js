import { execa } from 'execa';
import { createSshProvider } from './ssh.js';
import { createLogger } from '../../logger/index.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createEc2Provider(config, envName, env = process.env) {
  const log = createLogger('ec2');
  const instanceId = env.EC2_INSTANCE_ID;
  const region = env.AWS_REGION || 'us-east-1';

  async function resolveHost() {
    const environment = config.environments[envName];
    if (environment?.host || env.SSH_HOST) {
      return environment?.host || env.SSH_HOST;
    }

    if (!instanceId) {
      throw new Error(
        'EC2 host unknown. Set SSH_HOST to your instance public IP, or set EC2_INSTANCE_ID with AWS credentials for auto lookup.'
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
        `Could not resolve public IP for ${instanceId} — ${msg}. Set SSH_HOST manually or install/configure AWS CLI with ec2:DescribeInstances access.`
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

export default { createEc2Provider };
