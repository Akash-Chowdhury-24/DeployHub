import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const mockExeca = jest.fn();
jest.unstable_mockModule('execa', () => ({
  execa: mockExeca,
  default: mockExeca,
}));

const ensureKubernetesNamespace = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/utils/kubernetes-namespace.js', () => ({
  ensureKubernetesNamespace,
}));

const ensureImageReadyForDeploy = jest.fn().mockResolvedValue({
  ranCompose: false,
  fullImage: 'org/myapp:0.1.0-restored',
});

jest.unstable_mockModule('../src/utils/docker-image-deploy.js', () => ({
  createDockerImageDeployContext: (_config, env = {}) => ({
    fullImage: 'org/myapp:current-live-tag',
    ensureImageReadyForDeploy,
    getDockerEnv: () => ({}),
    hasRegistryCredentials: () =>
      Boolean(env.DOCKER_REGISTRY_USERNAME && env.DOCKER_REGISTRY_TOKEN),
  }),
}));

const { createKubernetesProvider } = await import(
  '../src/deployment/providers/kubernetes.js'
);

const REGISTRY_CREDS = {
  DOCKER_REGISTRY_USERNAME: 'user',
  DOCKER_REGISTRY_TOKEN: 'token',
};

/**
 * @param {string} tmp
 */
async function seedK8sArtifact(tmp) {
  const artifactDir = path.join(tmp, 'artifact');
  await fs.ensureDir(path.join(artifactDir, 'k8s'));
  await fs.writeFile(
    path.join(artifactDir, 'k8s', 'deployment.yaml'),
    'apiVersion: apps/v1\nkind: Deployment\n'
  );
  await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake');
  return artifactDir;
}

describe('kubernetes provider rollback (artifact-based)', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    jest.clearAllMocks();
    ensureImageReadyForDeploy.mockResolvedValue({
      ranCompose: false,
      fullImage: 'org/myapp:0.1.0-restored',
    });
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-k8s-rollback-'));
    mockExeca.mockImplementation(async (cmd, args = []) => {
      if (cmd === 'kubectl' && args[0] === 'get' && args[1] === 'deployment') {
        return { stdout: 'org/myapp:other' };
      }
      return { stdout: '' };
    });
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('rollback fails loudly with missing registry creds before apply', async () => {
    const artifactDir = await seedK8sArtifact(tmp);

    const provider = createKubernetesProvider(
      { project: 'myapp' },
      'production',
      {
        DOCKER_IMAGE_NAME: 'org/myapp',
        KUBE_NAMESPACE: 'demo',
        // no DOCKER_REGISTRY_USERNAME / TOKEN
      }
    );

    await expect(
      provider.rollback(artifactDir, {
        buildId: '0.1.0-restored',
        semver: '0.1.0',
        remoteKey: 'myapp/builds/0.1.0-restored/artifact.zip',
      })
    ).rejects.toThrow(/DOCKER_REGISTRY_USERNAME and DOCKER_REGISTRY_TOKEN/);

    expect(ensureImageReadyForDeploy).not.toHaveBeenCalled();
    const applyCalls = mockExeca.mock.calls.filter(
      (c) => c[0] === 'kubectl' && c[1]?.[0] === 'apply'
    );
    expect(applyCalls).toHaveLength(0);
  });

  test('rollback fails after set-image if rollout status times out', async () => {
    const artifactDir = await seedK8sArtifact(tmp);

    mockExeca.mockImplementation(async (cmd, args = []) => {
      if (cmd === 'kubectl' && args[0] === 'get' && args[1] === 'deployment') {
        return { stdout: 'org/myapp:other' };
      }
      if (
        cmd === 'kubectl' &&
        args[0] === 'rollout' &&
        args[1] === 'status'
      ) {
        throw new Error('error: timed out waiting for the condition');
      }
      return { stdout: '' };
    });

    const provider = createKubernetesProvider(
      { project: 'myapp' },
      'production',
      {
        DOCKER_IMAGE_NAME: 'org/myapp',
        KUBE_NAMESPACE: 'demo',
        ...REGISTRY_CREDS,
      }
    );

    await expect(
      provider.rollback(artifactDir, {
        buildId: '0.1.0-restored',
        semver: '0.1.0',
        remoteKey: 'myapp/builds/0.1.0-restored/artifact.zip',
      })
    ).rejects.toThrow(/did not become healthy within 120s/);

    expect(
      mockExeca.mock.calls.some((c) => c[0] === 'kubectl' && c[1]?.[0] === 'apply')
    ).toBe(true);
    expect(
      mockExeca.mock.calls.some(
        (c) => c[0] === 'kubectl' && c[1]?.[0] === 'set' && c[1]?.[1] === 'image'
      )
    ).toBe(true);
  });

  test('rollback succeeds when creds present and rollout succeeds', async () => {
    const artifactDir = await seedK8sArtifact(tmp);

    const provider = createKubernetesProvider(
      { project: 'myapp' },
      'production',
      {
        DOCKER_IMAGE_NAME: 'org/myapp',
        DOCKER_IMAGE_TAG: 'should-not-win',
        KUBE_NAMESPACE: 'demo',
        ...REGISTRY_CREDS,
      }
    );

    await provider.rollback(artifactDir, {
      buildId: '0.1.0-restored',
      semver: '0.1.0',
      remoteKey: 'myapp/builds/0.1.0-restored/artifact.zip',
    });

    const undoCalls = mockExeca.mock.calls.filter(
      (c) =>
        c[0] === 'kubectl' &&
        Array.isArray(c[1]) &&
        c[1][0] === 'rollout' &&
        c[1][1] === 'undo'
    );
    expect(undoCalls).toHaveLength(0);

    expect(ensureImageReadyForDeploy).toHaveBeenCalledWith(
      artifactDir,
      expect.objectContaining({
        fullImage: 'org/myapp:0.1.0-restored',
        skipImageReuse: true,
      })
    );

    const applyCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'kubectl' && c[1]?.[0] === 'apply'
    );
    expect(applyCall).toBeTruthy();
    expect(applyCall[1]).toEqual(
      expect.arrayContaining(['apply', '-f', path.join(artifactDir, 'k8s')])
    );

    const setImageCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'kubectl' && c[1]?.[0] === 'set' && c[1]?.[1] === 'image'
    );
    expect(setImageCall).toBeTruthy();
    expect(setImageCall[1]).toEqual(
      expect.arrayContaining([
        'set',
        'image',
        'deployment/myapp',
        'myapp=org/myapp:0.1.0-restored',
      ])
    );

    const statusCall = mockExeca.mock.calls.find(
      (c) =>
        c[0] === 'kubectl' && c[1]?.[0] === 'rollout' && c[1]?.[1] === 'status'
    );
    expect(statusCall).toBeTruthy();
    expect(statusCall[1]).toEqual(
      expect.arrayContaining([
        'rollout',
        'status',
        'deployment/myapp',
        '--timeout=120s',
      ])
    );
  });

  test('normal deploy without skipImageReuse does not require registry creds or rollout status', async () => {
    const artifactDir = await seedK8sArtifact(tmp);

    const provider = createKubernetesProvider(
      { project: 'myapp' },
      'production',
      {
        DOCKER_IMAGE_NAME: 'org/myapp',
        KUBE_NAMESPACE: 'demo',
        // no registry creds — allowed for normal deploy
      }
    );

    await provider.deploy(artifactDir);

    expect(ensureImageReadyForDeploy).toHaveBeenCalledWith(
      artifactDir,
      expect.objectContaining({ skipImageReuse: undefined })
    );
    const statusCalls = mockExeca.mock.calls.filter(
      (c) =>
        c[0] === 'kubectl' && c[1]?.[0] === 'rollout' && c[1]?.[1] === 'status'
    );
    expect(statusCalls).toHaveLength(0);
  });

  test('rollback finds manifests after layout normalization (top-level yaml)', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'deployment.yaml'), 'kind: Deployment\n');
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake');

    const provider = createKubernetesProvider(
      { project: 'demo' },
      'production',
      { DOCKER_IMAGE_NAME: 'demo', ...REGISTRY_CREDS }
    );

    await provider.rollback(artifactDir, {
      buildId: '2.0.0-abc',
      semver: '2.0.0',
      remoteKey: 'demo/builds/2.0.0-abc/artifact.zip',
    });

    expect(ensureImageReadyForDeploy).toHaveBeenCalledWith(
      artifactDir,
      expect.objectContaining({
        fullImage: 'demo:2.0.0-abc',
        skipImageReuse: true,
      })
    );

    const applyCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'kubectl' && c[1]?.[0] === 'apply'
    );
    expect(applyCall[1]).toEqual(expect.arrayContaining(['-f', artifactDir]));
  });

  test('rollback requires buildId', async () => {
    const provider = createKubernetesProvider({ project: 'myapp' }, 'production', {
      ...REGISTRY_CREDS,
    });
    await expect(provider.rollback(tmp, {})).rejects.toThrow(/requires buildId/);
  });

  test('rollback uses each environment config namespace in kubectl args', async () => {
    const artifactDir = await seedK8sArtifact(tmp);
    const config = {
      project: 'myapp',
      defaultEnvironment: 'production',
      environments: {
        testing: {
          enabled: true,
          method: 'kubernetes',
          trigger: 'manual',
          config: {
            kubeNamespace: 'staging-ns',
            dockerImageName: 'org/myapp',
          },
        },
        production: {
          enabled: true,
          method: 'kubernetes',
          trigger: 'manual',
          config: {
            kubeNamespace: 'prod-ns',
            dockerImageName: 'org/myapp',
          },
        },
      },
    };

    const productionProvider = createKubernetesProvider(config, 'production', {
      ...REGISTRY_CREDS,
    });
    await productionProvider.rollback(artifactDir, {
      buildId: '0.1.0-restored',
      semver: '0.1.0',
      remoteKey: 'myapp/builds/0.1.0-restored/artifact.zip',
    });

    const prodApply = mockExeca.mock.calls.find(
      (c) => c[0] === 'kubectl' && c[1]?.[0] === 'apply'
    );
    expect(prodApply?.[1]).toEqual(expect.arrayContaining(['--namespace', 'prod-ns']));

    jest.clearAllMocks();
    ensureImageReadyForDeploy.mockResolvedValue({
      ranCompose: false,
      fullImage: 'org/myapp:0.1.0-restored',
    });
    mockExeca.mockImplementation(async (cmd, args = []) => {
      if (cmd === 'kubectl' && args[0] === 'get' && args[1] === 'deployment') {
        return { stdout: 'org/myapp:other' };
      }
      return { stdout: '' };
    });

    const testingProvider = createKubernetesProvider(config, 'testing', {
      ...REGISTRY_CREDS,
    });
    await testingProvider.rollback(artifactDir, {
      buildId: '0.1.0-restored',
      semver: '0.1.0',
      remoteKey: 'myapp/builds/0.1.0-restored/artifact.zip',
    });

    const testApply = mockExeca.mock.calls.find(
      (c) => c[0] === 'kubectl' && c[1]?.[0] === 'apply'
    );
    expect(testApply?.[1]).toEqual(expect.arrayContaining(['--namespace', 'staging-ns']));
    expect(testApply?.[1]).not.toEqual(expect.arrayContaining(['--namespace', 'prod-ns']));
  });

  test('rollback uses shared createDockerImageDeployContext.ensureImageReadyForDeploy (no local copy)', async () => {
    const { readFileSync } = await import('node:fs');
    const pathMod = await import('node:path');
    const src = readFileSync(
      pathMod.join(process.cwd(), 'src/deployment/providers/kubernetes.js'),
      'utf8'
    );
    expect(src).toContain("from '../../utils/docker-image-deploy.js'");
    expect(src).toContain('createDockerImageDeployContext');
    expect(src).toMatch(/skipImageReuse:\s*true/);
    expect(src).not.toMatch(/function ensureImageReadyForDeploy/);
    expect(src).not.toMatch(/docker pull/);
  });
});
