import { jest } from '@jest/globals';

const mockExeca = jest.fn();
jest.unstable_mockModule('execa', () => ({
  execa: mockExeca,
  default: mockExeca,
}));

const mockDeploy = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const createSshProvider = jest.fn((_config, _envName, env) => ({
  deploy: mockDeploy,
  rollback: mockRollback,
  healthCheck: jest.fn().mockResolvedValue(true),
  testConnection: jest.fn().mockResolvedValue(undefined),
  connect: jest.fn().mockResolvedValue({ dispose: jest.fn() }),
  runRemoteCheck: jest.fn(),
  /** @type {string|undefined} */
  resolvedHostForTest: env.SSH_HOST,
}));

jest.unstable_mockModule('../src/deployment/providers/ssh.js', () => ({
  createSshProvider,
  default: { createSshProvider },
}));

const { createEc2Provider } = await import('../src/deployment/providers/ec2.js');
const { createAzureVmProvider } = await import(
  '../src/deployment/providers/azure-vm.js'
);
const { createGcpVmProvider } = await import('../src/deployment/providers/gcp-vm.js');

describe('cloud VM host resolution on deploy/rollback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeploy.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
  });

  describe('EC2', () => {
    test('deploy resolves host via instance-ID-only config (no SSH_HOST)', async () => {
      mockExeca.mockResolvedValue({ stdout: '203.0.113.50\n' });

      const config = {
        project: 'app',
        environments: { production: { type: 'ec2' } },
      };
      const provider = createEc2Provider(config, 'production', {
        EC2_INSTANCE_ID: 'i-abc123',
        AWS_REGION: 'us-east-1',
        SSH_USER: 'ec2-user',
        SSH_KEY_PATH: '/tmp/key',
      });

      await provider.deploy('/tmp/artifact');

      expect(mockExeca).toHaveBeenCalledWith(
        'aws',
        expect.arrayContaining([
          'ec2',
          'describe-instances',
          '--instance-ids',
          'i-abc123',
        ]),
        expect.any(Object)
      );
      expect(createSshProvider).toHaveBeenCalledWith(
        config,
        'production',
        expect.objectContaining({ SSH_HOST: '203.0.113.50' })
      );
      expect(mockDeploy).toHaveBeenCalledWith('/tmp/artifact', undefined);
      expect(config.environments.production.host).toBe('203.0.113.50');
    });

    test('rollback resolves host via instance-ID-only config', async () => {
      mockExeca.mockResolvedValue({ stdout: '198.51.100.10\n' });

      const provider = createEc2Provider(
        { project: 'app', environments: { production: { type: 'ec2' } } },
        'production',
        {
          EC2_INSTANCE_ID: 'i-rollback',
          SSH_USER: 'ec2-user',
          SSH_KEY_PATH: '/tmp/key',
        }
      );

      await provider.rollback('/tmp/artifact', { buildId: '1.0.0-old' });

      expect(createSshProvider).toHaveBeenCalledWith(
        expect.anything(),
        'production',
        expect.objectContaining({ SSH_HOST: '198.51.100.10' })
      );
      expect(mockRollback).toHaveBeenCalledWith('/tmp/artifact', {
        buildId: '1.0.0-old',
      });
    });

    test('deploy with explicit SSH_HOST skips cloud lookup', async () => {
      const provider = createEc2Provider(
        { project: 'app', environments: { production: { type: 'ec2' } } },
        'production',
        {
          SSH_HOST: '1.2.3.4',
          EC2_INSTANCE_ID: 'i-should-not-lookup',
          SSH_USER: 'ec2-user',
          SSH_KEY_PATH: '/tmp/key',
        }
      );

      await provider.deploy('/tmp/artifact');

      expect(mockExeca).not.toHaveBeenCalled();
      expect(createSshProvider).toHaveBeenCalledWith(
        expect.anything(),
        'production',
        expect.objectContaining({ SSH_HOST: '1.2.3.4' })
      );
      expect(mockDeploy).toHaveBeenCalled();
    });

    test('fails clearly when neither SSH_HOST nor instance id is set', async () => {
      const provider = createEc2Provider(
        { project: 'app', environments: { production: { type: 'ec2' } } },
        'production',
        { SSH_USER: 'ec2-user', SSH_KEY_PATH: '/tmp/key' }
      );

      await expect(provider.deploy('/tmp/artifact')).rejects.toThrow(
        /Could not resolve host via EC2 instance lookup, and no SSH_HOST was set/
      );
      expect(mockDeploy).not.toHaveBeenCalled();
    });
  });

  describe('Azure VM', () => {
    test('deploy resolves host via VM name lookup without SSH_HOST', async () => {
      mockExeca.mockResolvedValue({ stdout: '20.0.0.5\n' });

      const config = {
        project: 'app',
        environments: { production: { type: 'azure-vm' } },
      };
      const provider = createAzureVmProvider(config, 'production', {
        AZURE_SUBSCRIPTION_ID: 'sub',
        AZURE_RESOURCE_GROUP: 'rg',
        AZURE_VM_NAME: 'my-vm',
        SSH_USER: 'azureuser',
        SSH_KEY_PATH: '/tmp/key',
      });

      await provider.deploy('/tmp/artifact');

      expect(mockExeca).toHaveBeenCalledWith(
        'az',
        expect.arrayContaining(['vm', 'show', '-n', 'my-vm']),
        expect.any(Object)
      );
      expect(createSshProvider).toHaveBeenCalledWith(
        config,
        'production',
        expect.objectContaining({ SSH_HOST: '20.0.0.5' })
      );
      expect(mockDeploy).toHaveBeenCalled();
    });

    test('rollback with explicit SSH_HOST skips az lookup', async () => {
      const provider = createAzureVmProvider(
        { project: 'app', environments: { production: { type: 'azure-vm' } } },
        'production',
        {
          SSH_HOST: '10.0.0.9',
          AZURE_VM_NAME: 'should-not-lookup',
          SSH_USER: 'azureuser',
          SSH_KEY_PATH: '/tmp/key',
        }
      );

      await provider.rollback('/tmp/artifact', { buildId: 'x' });

      expect(mockExeca).not.toHaveBeenCalled();
      expect(createSshProvider).toHaveBeenCalledWith(
        expect.anything(),
        'production',
        expect.objectContaining({ SSH_HOST: '10.0.0.9' })
      );
      expect(mockRollback).toHaveBeenCalled();
    });
  });

  describe('GCP VM', () => {
    test('deploy resolves host via instance name without SSH_HOST', async () => {
      mockExeca.mockResolvedValue({ stdout: '34.1.2.3\n' });

      const config = {
        project: 'app',
        environments: { production: { type: 'gcp-vm' } },
      };
      const provider = createGcpVmProvider(config, 'production', {
        GCP_PROJECT_ID: 'proj',
        GCP_ZONE: 'us-central1-a',
        GCP_INSTANCE_NAME: 'gce-1',
        SSH_USER: 'ubuntu',
        SSH_KEY_PATH: '/tmp/key',
      });

      await provider.deploy('/tmp/artifact');

      expect(mockExeca).toHaveBeenCalledWith(
        'gcloud',
        expect.arrayContaining([
          'compute',
          'instances',
          'describe',
          'gce-1',
        ]),
        expect.any(Object)
      );
      expect(createSshProvider).toHaveBeenCalledWith(
        config,
        'production',
        expect.objectContaining({ SSH_HOST: '34.1.2.3' })
      );
      expect(mockDeploy).toHaveBeenCalled();
    });

    test('rollback with explicit SSH_HOST skips gcloud lookup', async () => {
      const provider = createGcpVmProvider(
        { project: 'app', environments: { production: { type: 'gcp-vm' } } },
        'production',
        {
          SSH_HOST: '35.9.9.9',
          GCP_INSTANCE_NAME: 'should-not-lookup',
          SSH_USER: 'ubuntu',
          SSH_KEY_PATH: '/tmp/key',
        }
      );

      await provider.rollback('/tmp/artifact', { buildId: 'y' });

      expect(mockExeca).not.toHaveBeenCalled();
      expect(createSshProvider).toHaveBeenCalledWith(
        expect.anything(),
        'production',
        expect.objectContaining({ SSH_HOST: '35.9.9.9' })
      );
      expect(mockRollback).toHaveBeenCalled();
    });
  });
});
