/**
 * Storage vs deployment cloud-API lookup credential namespace collision.
 * Ensures S3/GCP Storage vars never share names with EC2/GCP VM lookup vars,
 * and .env.example / checklist keep the two concerns distinct.
 */
import { jest } from '@jest/globals';

const mockExeca = jest.fn();
jest.unstable_mockModule('execa', () => ({
  execa: mockExeca,
  default: mockExeca,
}));

const createSshProvider = jest.fn((_config, _envName, env) => ({
  deploy: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  healthCheck: jest.fn().mockResolvedValue(true),
  testConnection: jest.fn().mockResolvedValue(undefined),
  connect: jest.fn().mockResolvedValue({ dispose: jest.fn() }),
  runRemoteCheck: jest.fn(),
  resolvedHostForTest: env.SSH_HOST,
}));

jest.unstable_mockModule('../src/deployment/providers/ssh.js', () => ({
  createSshProvider,
  default: { createSshProvider },
}));

const { generateEnvExampleContent, getGithubSecretsChecklist, PROVIDER_ENV_MAP } =
  await import('../src/utils/github-actions.js');
const { DEPLOYMENT_ENV_KEYS, DEPLOYMENT_LOOKUP_ENV_KEYS, prefixSecretKey } =
  await import('../src/deployment/deployment-env.js');
const { createEc2Provider } = await import('../src/deployment/providers/ec2.js');
const { createGcpVmProvider } = await import('../src/deployment/providers/gcp-vm.js');

const STORAGE_IDS = ['aws', 'azure', 'gcp', 'gdrive', 'dropbox', 'ftp', 'local'];
const LOOKUP_METHODS = ['ec2', 'azure-vm', 'gcp-vm', 'docker', 'kubernetes', 'ssh'];

describe('storage vs deployment lookup credential namespace', () => {
  test('collision audit: no storage env key overlaps any deployment method key', () => {
    /** @type {string[]} */
    const collisions = [];
    for (const storageId of STORAGE_IDS) {
      const storageKeys = new Set(PROVIDER_ENV_MAP[storageId] || []);
      for (const method of LOOKUP_METHODS) {
        for (const key of DEPLOYMENT_ENV_KEYS[method] || []) {
          if (storageKeys.has(key)) {
            collisions.push(`${storageId} ∩ ${method}: ${key}`);
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test('DEPLOYMENT_LOOKUP_ENV_KEYS lists every cloud-lookup credential', () => {
    expect(DEPLOYMENT_LOOKUP_ENV_KEYS.has('EC2_LOOKUP_AWS_ACCESS_KEY_ID')).toBe(true);
    expect(DEPLOYMENT_LOOKUP_ENV_KEYS.has('GCP_VM_LOOKUP_PROJECT_ID')).toBe(true);
    expect(DEPLOYMENT_LOOKUP_ENV_KEYS.has('AZURE_VM_LOOKUP_SUBSCRIPTION_ID')).toBe(true);
    expect(DEPLOYMENT_LOOKUP_ENV_KEYS.has('AWS_ACCESS_KEY_ID')).toBe(false);
    expect(DEPLOYMENT_LOOKUP_ENV_KEYS.has('GCP_PROJECT_ID')).toBe(false);
  });

  test('single-env S3+EC2 .env.example: each section once; storage ≠ lookup AWS names', () => {
    const content = generateEnvExampleContent(
      ['aws'],
      ['production'],
      { production: { type: 'ec2' } },
      { projectType: 'backend', project: 'app', port: 3000, storage: ['aws'] }
    );

    expect((content.match(/# AWS S3\b/g) || []).length).toBe(1);
    expect((content.match(/# AWS EC2 Deployment\b/g) || []).length).toBe(1);

    expect(content).toMatch(/^AWS_ACCESS_KEY_ID=/m);
    expect(content).toMatch(/^AWS_SECRET_ACCESS_KEY=/m);
    expect(content).toMatch(/^AWS_REGION=/m);
    expect(content).toMatch(/^EC2_LOOKUP_AWS_ACCESS_KEY_ID=/m);
    expect(content).toMatch(/^EC2_LOOKUP_AWS_SECRET_ACCESS_KEY=/m);
    expect(content).toMatch(/^EC2_LOOKUP_AWS_REGION=/m);
    const ec2Block = content.split('# AWS EC2 Deployment')[1] || '';
    expect(ec2Block).not.toMatch(/^AWS_ACCESS_KEY_ID=/m);
    expect(ec2Block).not.toMatch(/^AWS_SECRET_ACCESS_KEY=/m);
    expect(ec2Block).not.toMatch(/^AWS_REGION=/m);
  });

  test('single-env GCP Storage + GCP VM: distinct project/key var names', () => {
    const content = generateEnvExampleContent(
      ['gcp'],
      ['production'],
      { production: { type: 'gcp-vm' } },
      { projectType: 'frontend', project: 'app', storage: ['gcp'] }
    );

    expect((content.match(/# GCP Storage\b/g) || []).length).toBe(1);
    expect((content.match(/# GCP VM Deployment\b/g) || []).length).toBe(1);
    expect(content).toMatch(/^GCP_PROJECT_ID=/m);
    expect(content).toMatch(/^GCP_KEY_FILE=/m);
    expect(content).toMatch(/^GCP_VM_LOOKUP_PROJECT_ID=/m);
    expect(content).toMatch(/^GCP_VM_LOOKUP_KEY_FILE=/m);
  });

  test('multi-env EC2: prefixed second env; no byte-identical duplicate blocks', () => {
    const environments = {
      development: { type: 'ec2', host: '1.1.1.1' },
      production: { type: 'ec2', host: '2.2.2.2' },
    };
    const config = {
      projectType: 'frontend',
      project: 'app',
      storage: ['aws'],
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments,
    };
    const content = generateEnvExampleContent(
      ['aws'],
      ['development', 'production'],
      environments,
      config
    );

    expect(content).toContain('# AWS EC2 Deployment (development)');
    expect(content).toContain('# AWS EC2 Deployment (production)');
    expect(content).toMatch(/^EC2_LOOKUP_AWS_ACCESS_KEY_ID=/m);
    expect(content).toMatch(/^PRODUCTION_EC2_LOOKUP_AWS_ACCESS_KEY_ID=/m);
    expect(content).toMatch(/^PRODUCTION_SSH_HOST=/m);

    const parts = content.split(/# AWS EC2 Deployment/);
    expect(parts.length).toBe(3); // before + 2 sections
    expect(parts[1]).not.toBe(parts[2]);
  });

  test('duplicate env name in deploy list emits section only once', () => {
    const content = generateEnvExampleContent(
      [],
      ['production', 'production'],
      { production: { type: 'ec2' } },
      { projectType: 'frontend', project: 'app' }
    );
    expect((content.match(/# AWS EC2 Deployment\b/g) || []).length).toBe(1);
  });

  test('accidental ec2 in storageProviders does not emit a second EC2 section', () => {
    const content = generateEnvExampleContent(
      ['aws', 'ec2'],
      ['production'],
      { production: { type: 'ec2' } },
      { projectType: 'frontend', project: 'app' }
    );
    expect((content.match(/# AWS EC2 Deployment\b/g) || []).length).toBe(1);
    expect((content.match(/# AWS S3\b/g) || []).length).toBe(1);
  });

  test('secrets checklist labels storage vs EC2 lookup distinctly', () => {
    const checklist = getGithubSecretsChecklist(
      ['aws'],
      ['production'],
      { production: { type: 'ec2' } },
      { projectType: 'frontend' }
    );
    const storageKey = checklist.find((i) => i.key === 'AWS_ACCESS_KEY_ID');
    const lookupKey = checklist.find((i) => i.key === 'EC2_LOOKUP_AWS_ACCESS_KEY_ID');
    expect(storageKey?.required).toBe(true);
    expect(storageKey?.note).toMatch(/S3 storage/i);
    expect(lookupKey?.required).toBe(false);
    expect(lookupKey?.note).toMatch(/lookup/i);
    expect(lookupKey?.key).not.toBe(storageKey?.key);
  });

  test('prefixed second env checklist uses PRODUCTION_EC2_LOOKUP_*', () => {
    const environments = {
      development: { type: 'ec2' },
      production: { type: 'ec2' },
    };
    const config = {
      projectType: 'frontend',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments,
    };
    const checklist = getGithubSecretsChecklist(
      ['aws'],
      ['development', 'production'],
      environments,
      config
    );
    expect(checklist.some((i) => i.key === 'EC2_LOOKUP_AWS_ACCESS_KEY_ID')).toBe(true);
    expect(
      checklist.some((i) => i.key === 'PRODUCTION_EC2_LOOKUP_AWS_ACCESS_KEY_ID')
    ).toBe(true);
    expect(prefixSecretKey('production', 'EC2_LOOKUP_AWS_ACCESS_KEY_ID')).toBe(
      'PRODUCTION_EC2_LOOKUP_AWS_ACCESS_KEY_ID'
    );
  });

  test('EC2 runtime reads EC2_LOOKUP_* (not storage AWS_*) when both set differently', async () => {
    mockExeca.mockResolvedValue({ stdout: '203.0.113.50\n' });
    createSshProvider.mockClear();

    const config = {
      project: 'app',
      environments: { production: { type: 'ec2' } },
    };
    const provider = createEc2Provider(config, 'production', {
      EC2_INSTANCE_ID: 'i-abc',
      // Storage-flavored names — must NOT be used for DescribeInstances
      AWS_ACCESS_KEY_ID: 'STORAGE_KEY',
      AWS_SECRET_ACCESS_KEY: 'STORAGE_SECRET',
      AWS_REGION: 'eu-west-1',
      // Distinct lookup credentials
      EC2_LOOKUP_AWS_ACCESS_KEY_ID: 'LOOKUP_KEY',
      EC2_LOOKUP_AWS_SECRET_ACCESS_KEY: 'LOOKUP_SECRET',
      EC2_LOOKUP_AWS_REGION: 'us-east-1',
      SSH_USER: 'ec2-user',
      SSH_KEY_PATH: '/tmp/key',
    });

    await provider.deploy('/tmp/a');

    expect(mockExeca).toHaveBeenCalledWith(
      'aws',
      expect.arrayContaining(['--region', 'us-east-1']),
      expect.objectContaining({
        env: expect.objectContaining({
          AWS_ACCESS_KEY_ID: 'LOOKUP_KEY',
          AWS_SECRET_ACCESS_KEY: 'LOOKUP_SECRET',
        }),
      })
    );
  });

  test('GCP VM runtime reads GCP_VM_LOOKUP_* distinct from storage GCP_*', async () => {
    mockExeca.mockResolvedValue({ stdout: '34.1.2.3\n' });
    createSshProvider.mockClear();

    const config = {
      project: 'app',
      environments: { production: { type: 'gcp-vm' } },
    };
    const provider = createGcpVmProvider(config, 'production', {
      GCP_PROJECT_ID: 'storage-project',
      GCP_KEY_FILE: '/tmp/storage.json',
      GCP_VM_LOOKUP_PROJECT_ID: 'compute-project',
      GCP_VM_LOOKUP_KEY_FILE: '/tmp/compute.json',
      GCP_ZONE: 'us-central1-a',
      GCP_INSTANCE_NAME: 'vm-1',
      SSH_USER: 'ubuntu',
      SSH_KEY_PATH: '/tmp/key',
    });

    await provider.deploy('/tmp/a');

    expect(mockExeca).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining(['--project', 'compute-project']),
      expect.objectContaining({
        env: expect.objectContaining({
          GOOGLE_APPLICATION_CREDENTIALS: '/tmp/compute.json',
        }),
      })
    );
  });

  test('EC2 ignores bare AWS_* storage names when EC2_LOOKUP_* unset', async () => {
    mockExeca.mockResolvedValue({ stdout: '198.51.100.1\n' });
    const provider = createEc2Provider(
      { project: 'app', environments: { production: { type: 'ec2' } } },
      'production',
      {
        EC2_INSTANCE_ID: 'i-only-storage-aws',
        AWS_ACCESS_KEY_ID: 'STORAGE_ONLY',
        AWS_SECRET_ACCESS_KEY: 'STORAGE_ONLY',
        AWS_REGION: 'ap-south-1',
        SSH_USER: 'ec2-user',
        SSH_KEY_PATH: '/tmp/key',
      }
    );
    await provider.deploy('/tmp/a');
    // Must not copy storage AWS_* into the CLI env for lookup.
    expect(mockExeca).toHaveBeenCalledWith(
      'aws',
      expect.arrayContaining(['--region', 'us-east-1']),
      expect.objectContaining({
        env: expect.not.objectContaining({
          AWS_ACCESS_KEY_ID: 'STORAGE_ONLY',
        }),
      })
    );
  });
});
