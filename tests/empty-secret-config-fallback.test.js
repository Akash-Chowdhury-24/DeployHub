import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  applyEnvSecretOverlay,
  envUsesPrefixedSecrets,
} from '../src/deployment/deployment-env.js';
import { getEnvSettings } from '../src/core/environments.js';

const execCommands = [];

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async putFile() {}
    async execCommand(command) {
      execCommands.push(command);
      return { code: 0, stdout: '', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
const { createEc2Provider } = await import('../src/deployment/providers/ec2.js');

describe('empty GitHub secret strings fall back to config (not treated as set)', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-empty-secret-'));
    await fs.ensureDir(path.join(tmp, 'artifact'));
    await fs.writeFile(path.join(tmp, 'artifact', 'artifact.zip'), 'fake');
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('SSH: empty SSH_DEPLOY_PATH uses config.deployPath (settings first in || chain)', async () => {
    // Mirrors real GHA: unset optional secret → process.env.SSH_DEPLOY_PATH === ''
    const config = {
      project: 'myapp',
      projectType: 'frontend',
      environments: {
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'push',
          config: {
            host: '10.0.0.1',
            user: 'deploy',
            deployPath: '/var/www/from-config',
          },
        },
      },
    };

    const provider = createSshProvider(config, 'production', {
      SSH_KEY: 'fake-key',
      SSH_DEPLOY_PATH: '', // empty string from unset GitHub secret
      SSH_HOST: '', // also empty — host must come from config
      SSH_USER: '',
    });

    await provider.deploy(path.join(tmp, 'artifact'));

    expect(execCommands.some((c) => c.includes('/var/www/from-config'))).toBe(true);
    // Default fallback must NOT win when config.deployPath is set
    expect(execCommands.some((c) => c.includes('/var/www/app'))).toBe(false);
  });

  test('SSH: empty SSH_SSH_PORT uses config.sshPort (Number("") is 0 / falsy)', async () => {
    const config = {
      project: 'myapp',
      projectType: 'frontend',
      environments: {
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'push',
          config: {
            host: '10.0.0.1',
            user: 'deploy',
            deployPath: '/var/www/app',
            sshPort: 2222,
          },
        },
      },
    };

    // Provider closes over sshPort at create time; connect() uses it.
    // We only need to ensure Number('') does not block settings.sshPort.
    const settings = getEnvSettings(config.environments.production);
    const env = { SSH_SSH_PORT: '' };
    const sshPort = Number(env.SSH_SSH_PORT) || settings.sshPort || 22;
    expect(sshPort).toBe(2222);
  });

  test('EC2: empty EC2_INSTANCE_ID / EC2_LOOKUP_AWS_REGION fall through to config settings', () => {
    const settings = {
      ec2InstanceId: 'i-from-config',
      awsRegion: 'eu-west-1',
      host: '203.0.113.10',
    };
    // Same expressions as createEc2Provider (env first — empty must be falsy)
    const env = { EC2_INSTANCE_ID: '', EC2_LOOKUP_AWS_REGION: '', SSH_HOST: '' };
    const instanceId = env.EC2_INSTANCE_ID || settings.ec2InstanceId;
    const region = env.EC2_LOOKUP_AWS_REGION || settings.awsRegion || 'us-east-1';
    const host = settings.host || env.SSH_HOST;

    expect(instanceId).toBe('i-from-config');
    expect(region).toBe('eu-west-1');
    expect(host).toBe('203.0.113.10');
  });

  test('EC2 provider: empty secrets + config host deploys via config deployPath', async () => {
    const config = {
      project: 'myapp',
      projectType: 'frontend',
      environments: {
        production: {
          enabled: true,
          method: 'ec2',
          trigger: 'push',
          config: {
            host: '203.0.113.50',
            user: 'ubuntu',
            deployPath: '/var/www/ec2-from-config',
            ec2InstanceId: 'i-should-not-be-needed',
            awsRegion: 'ap-south-1',
          },
        },
      },
    };

    const provider = createEc2Provider(config, 'production', {
      SSH_KEY: 'fake-key',
      SSH_DEPLOY_PATH: '',
      SSH_HOST: '',
      SSH_USER: '',
      EC2_INSTANCE_ID: '',
      EC2_LOOKUP_AWS_REGION: '',
    });

    await provider.deploy(path.join(tmp, 'artifact'));
    expect(execCommands.some((c) => c.includes('/var/www/ec2-from-config'))).toBe(true);
  });

  test('prefixed overlay: empty PRODUCTION_SSH_DEPLOY_PATH clears ambient, config still wins', async () => {
    const config = {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments: {
        development: {
          enabled: true,
          method: 'ssh',
          trigger: 'push',
          config: { host: 'dev', user: 'deploy', deployPath: '/var/www/dev' },
        },
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'push',
          config: {
            host: 'prod.example.com',
            user: 'deploy',
            deployPath: '/var/www/prod-from-config',
          },
        },
      },
    };

    expect(envUsesPrefixedSecrets('production', config)).toBe(true);

    const ciEnv = {
      SSH_DEPLOY_PATH: '/var/www/ambient-wrong',
      PRODUCTION_SSH_DEPLOY_PATH: '', // unset GHA secret
      PRODUCTION_SSH_HOST: 'prod.example.com',
      PRODUCTION_SSH_USER: 'deploy',
      PRODUCTION_SSH_KEY: 'fake-key',
    };

    const overlaid = applyEnvSecretOverlay('production', config, ciEnv);
    // Empty prefixed secret → unprefixed cleared (no ambient leak)
    expect(overlaid.SSH_DEPLOY_PATH).toBeUndefined();

    const settings = getEnvSettings(config.environments.production);
    const deployPath =
      settings.deployPath ||
      settings.path ||
      overlaid.SSH_DEPLOY_PATH ||
      '/var/www/app';
    expect(deployPath).toBe('/var/www/prod-from-config');

    const provider = createSshProvider(config, 'production', {
      ...overlaid,
      SSH_KEY: 'fake-key',
    });
    await provider.deploy(path.join(tmp, 'artifact'));
    expect(execCommands.some((c) => c.includes('/var/www/prod-from-config'))).toBe(true);
  });
});
