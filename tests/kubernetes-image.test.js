import { jest } from '@jest/globals';

const mockExeca = jest.fn();
jest.unstable_mockModule('execa', () => ({
  execa: mockExeca,
  default: mockExeca,
}));

const { checkImagePullability } = await import('../src/utils/docker-image-deploy.js');
import {
  getDeploymentSecretKeys,
  getDeploymentWorkflowSecretKeys,
  getDeploymentSecretChecklistItems,
} from '../src/deployment/deployment-env.js';
import { generateWorkflowYaml } from '../src/utils/github-actions.js';
import { generateEnvExampleContent } from '../src/utils/github-actions.js';

describe('kubernetes registry secrets and workflow wiring', () => {
  test('getDeploymentSecretKeys requires image name and registry credentials', () => {
    const keys = getDeploymentSecretKeys('kubernetes');
    expect(keys).toContain('KUBE_CONTEXT');
    expect(keys).toContain('DOCKER_IMAGE_NAME');
    expect(keys).toContain('DOCKER_REGISTRY_USERNAME');
    expect(keys).toContain('DOCKER_REGISTRY_TOKEN');
    expect(keys).not.toContain('DOCKER_REGISTRY_URL');
    expect(keys).not.toContain('KUBE_IMAGE_PULL_SECRET');
  });

  test('getDeploymentWorkflowSecretKeys wires registry vars for CI', () => {
    const keys = getDeploymentWorkflowSecretKeys('kubernetes');
    expect(keys).toContain('DOCKER_REGISTRY_USERNAME');
    expect(keys).toContain('DOCKER_REGISTRY_TOKEN');
    expect(keys).toContain('DOCKER_REGISTRY_URL');
    expect(keys).toContain('DOCKER_IMAGE_NAME');
  });

  test('workflow yaml includes docker registry secrets for kubernetes deploy', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['production'],
      { production: { type: 'kubernetes' } },
      'npm:@akash-chowdhury-24/deployhub',
      { projectType: 'frontend', framework: 'react', project: 'my-app' }
    );
    expect(yaml).toContain('DOCKER_REGISTRY_USERNAME: ${{ secrets.DOCKER_REGISTRY_USERNAME }}');
    expect(yaml).toContain('DOCKER_REGISTRY_TOKEN: ${{ secrets.DOCKER_REGISTRY_TOKEN }}');
    expect(yaml).toContain('DOCKER_IMAGE_NAME: ${{ secrets.DOCKER_IMAGE_NAME }}');
  });

  test('checklist marks registry credentials required for kubernetes', () => {
    const items = getDeploymentSecretChecklistItems('kubernetes');
    const username = items.find((i) => i.key === 'DOCKER_REGISTRY_USERNAME');
    const token = items.find((i) => i.key === 'DOCKER_REGISTRY_TOKEN');
    const registryUrl = items.find((i) => i.key === 'DOCKER_REGISTRY_URL');
    expect(username?.required).toBe(true);
    expect(token?.required).toBe(true);
    expect(registryUrl?.required).toBe(false);
  });

  test('env example includes registry vars for kubernetes', () => {
    const content = generateEnvExampleContent(
      [],
      ['production'],
      {
        production: {
          type: 'kubernetes',
          kubeNamespace: 'my-app',
          dockerRegistryUrl: '',
        },
      },
      { projectType: 'frontend', project: 'my-app' }
    );
    expect(content).toContain('DOCKER_REGISTRY_USERNAME=');
    expect(content).toContain('DOCKER_REGISTRY_TOKEN=');
    expect(content).toContain('DOCKER_IMAGE_NAME=my-app');
    expect(content).not.toMatch(/OPTIONAL — only required if your manifests need an image override/);
  });
});

describe('checkImagePullability', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('reports success when manifest inspect succeeds', async () => {
    mockExeca.mockResolvedValue({ stdout: '{}' });

    const result = await checkImagePullability(
      { project: 'demo-app', version: '0.0.0' },
      { DOCKER_IMAGE_NAME: 'myuser/demo-app', DOCKER_IMAGE_TAG: '0.0.0' }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('myuser/demo-app:0.0.0 is pullable');
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['manifest', 'inspect', 'myuser/demo-app:0.0.0'],
      expect.any(Object)
    );
  });

  test('reports actionable failure when image is not found', async () => {
    const err = new Error('manifest unknown');
    err.stderr = 'manifest unknown: docker.io/library/missing:0.0.0';
    mockExeca.mockRejectedValue(err);

    const result = await checkImagePullability(
      { project: 'missing', version: '0.0.0' },
      { DOCKER_IMAGE_NAME: 'missing', DOCKER_IMAGE_TAG: '0.0.0' }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('missing:0.0.0 is not pullable');
    expect(result.message).toContain('docker push missing:0.0.0');
    expect(result.message).toContain('DOCKER_REGISTRY_USERNAME');
  });

  test('logs in before inspect when registry credentials are set', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: 'Login Succeeded' })
      .mockResolvedValueOnce({ stdout: '{}' });

    await checkImagePullability(
      { project: 'demo-app', version: '1.0.0' },
      {
        DOCKER_IMAGE_NAME: 'myuser/demo-app',
        DOCKER_IMAGE_TAG: '1.0.0',
        DOCKER_REGISTRY_USERNAME: 'myuser',
        DOCKER_REGISTRY_TOKEN: 'secret',
      }
    );

    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['login', 'https://index.docker.io/v1/', '-u', 'myuser', '--password-stdin'],
      expect.objectContaining({ input: 'secret' })
    );
  });
});

describe('getDockerEnvSecrets for kubernetes', () => {
  test('returns registry vars for kubernetes deploy answers', async () => {
    const { getDockerEnvSecrets } = await import('../src/deployment/init-prompts.js');
    const secrets = getDockerEnvSecrets({
      deployType: 'kubernetes',
      dockerRegistryUsername: 'myuser',
      dockerRegistryToken: 'tok123',
    });
    expect(secrets).toEqual({
      DOCKER_REGISTRY_USERNAME: 'myuser',
      DOCKER_REGISTRY_TOKEN: 'tok123',
    });
  });
});
