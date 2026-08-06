import { jest } from '@jest/globals';

const sshReachability = jest.fn();
const sshKeyDoctor = jest.fn();
const checkImagePull = jest.fn();
const providerFactory = jest.fn();
const namespaceExistsFn = jest.fn();

jest.unstable_mockModule('../src/deployment/init-helpers.js', () => ({
  testSshConnectivity: jest.fn(),
  validateSshKeyForDoctor: (...args) => sshKeyDoctor(...args),
  testSshHostReachability: (...args) => sshReachability(...args),
}));

jest.unstable_mockModule('../src/utils/docker-image-deploy.js', () => ({
  checkImagePullability: (...args) => checkImagePull(...args),
}));

jest.unstable_mockModule('../src/deployment/index.js', () => ({
  getDeploymentProvider: (...args) => providerFactory(...args),
}));

jest.unstable_mockModule('../src/utils/kubernetes-namespace.js', () => ({
  namespaceExists: (...args) => namespaceExistsFn(...args),
  ensureKubernetesNamespace: jest.fn(),
}));

const { runDeploymentChecks } = await import('../src/commands/doctor.js');

describe('doctor mocked provider failures (per-env)', () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
    sshReachability.mockReset();
    sshKeyDoctor.mockReset();
    checkImagePull.mockReset();
    providerFactory.mockReset();
    namespaceExistsFn.mockReset();
  });

  test('SSH: unreachable host fails with env name prefixable check for that env', async () => {
    process.env.SSH_HOST = '10.0.0.99';
    process.env.SSH_USER = 'deploy';
    process.env.SSH_KEY = '-----BEGIN FAKE KEY-----';
    sshKeyDoctor.mockResolvedValue({ ok: true, message: 'key ok' });
    sshReachability.mockResolvedValue({
      ok: false,
      message: 'Connection refused to 10.0.0.99:22',
    });
    providerFactory.mockReturnValue({
      runRemoteCheck: async () => ({ pass: true, message: 'ok' }),
    });

    const config = {
      project: 'demo',
      projectType: 'backend',
      framework: 'express',
      environments: {
        staging: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: { host: '10.0.0.99', user: 'deploy', deployPath: '/var/www/staging' },
        },
      },
    };

    const checks = await runDeploymentChecks(
      config,
      'staging',
      config.environments.staging
    );
    const named = checks.map((c) => ({ ...c, name: `staging/${c.name}` }));
    const reach = named.find((c) => c.name === 'staging/SSH host reachability');
    expect(reach).toBeDefined();
    expect(reach?.pass).toBe(false);
    expect(reach?.message).toMatch(/Connection refused|10\.0\.0\.99/);
    expect(sshReachability).toHaveBeenCalled();
  });

  test('Docker: invalid registry credentials fail Container image pullable for non-default env', async () => {
    process.env.DOCKER_IMAGE_NAME = 'myorg/app';
    process.env.DOCKER_REGISTRY_USERNAME = 'bad-user';
    process.env.DOCKER_REGISTRY_TOKEN = 'bad-token';
    providerFactory.mockReturnValue({
      testConnection: async () => {},
    });
    checkImagePull.mockResolvedValue({
      ok: false,
      message:
        'Image myorg/app:latest is not pullable — registry login failed. Check DOCKER_REGISTRY_USERNAME and DOCKER_REGISTRY_TOKEN.',
    });

    const config = {
      project: 'demo',
      projectType: 'frontend',
      framework: 'react',
      defaultEnvironment: 'production',
      environments: {
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: {},
        },
        staging: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: { dockerImageName: 'myorg/app' },
        },
      },
    };

    const checks = await runDeploymentChecks(
      config,
      'staging',
      config.environments.staging
    );
    const named = checks.map((c) => ({ ...c, name: `staging/${c.name}` }));
    const pullable = named.find((c) => c.name === 'staging/Container image pullable');
    expect(pullable).toBeDefined();
    expect(pullable?.pass).toBe(false);
    expect(pullable?.message).toMatch(/registry|DOCKER_REGISTRY/i);
  });

  test('Kubernetes: unreachable kubeconfig fails only that env; other env cluster check can still pass', async () => {
    process.env.KUBE_CONTEXT = 'bad-ctx';
    process.env.DOCKER_IMAGE_NAME = 'ghcr.io/org/app';
    process.env.DOCKER_REGISTRY_USERNAME = 'u';
    process.env.DOCKER_REGISTRY_TOKEN = 't';
    namespaceExistsFn.mockResolvedValue(true);

    providerFactory.mockImplementation((_type, _config, envName) => {
      if (envName === 'broken') {
        return {
          testConnection: async () => {
            throw new Error('Unable to connect to the server: dial tcp: lookup bad-cluster');
          },
        };
      }
      return {
        testConnection: async () => {},
      };
    });
    checkImagePull.mockResolvedValue({ ok: true, message: 'Image pullable' });

    const config = {
      project: 'demo',
      projectType: 'backend',
      framework: 'express',
      environments: {
        healthy: {
          enabled: true,
          method: 'kubernetes',
          trigger: 'manual',
          config: { kubeNamespace: 'healthy-ns', kubeContext: 'good' },
        },
        broken: {
          enabled: true,
          method: 'kubernetes',
          trigger: 'manual',
          config: { kubeNamespace: 'broken-ns', kubeContext: 'bad' },
        },
      },
    };

    const brokenChecks = await runDeploymentChecks(
      config,
      'broken',
      config.environments.broken
    );
    const healthyChecks = await runDeploymentChecks(
      config,
      'healthy',
      config.environments.healthy
    );

    const brokenCluster = brokenChecks
      .map((c) => ({ ...c, name: `broken/${c.name}` }))
      .find((c) => c.name === 'broken/Kubernetes cluster');
    const healthyCluster = healthyChecks
      .map((c) => ({ ...c, name: `healthy/${c.name}` }))
      .find((c) => c.name === 'healthy/Kubernetes cluster');

    expect(brokenCluster?.pass).toBe(false);
    expect(brokenCluster?.message).toMatch(
      /kubectl cluster-info failed|Unable to connect|bad-cluster/i
    );
    expect(healthyCluster?.pass).toBe(true);
    expect(healthyCluster?.message).toMatch(/cluster-info OK/i);
  });
});
