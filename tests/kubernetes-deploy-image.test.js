import { jest } from '@jest/globals';
import { syncKubernetesDeploymentImage } from '../src/utils/kubernetes-deploy-image.js';
import {
  EXPLICIT_IMAGE_TAG_WARNING,
  resolveDockerImageRef,
} from '../src/utils/docker-image.js';
import { createDockerImageDeployContext } from '../src/utils/docker-image-deploy.js';

describe('syncKubernetesDeploymentImage', () => {
  /** @type {jest.Mock} */
  let execaFn;
  /** @type {{ info: jest.Mock, warn: jest.Mock }} */
  let log;

  beforeEach(() => {
    execaFn = jest.fn();
    log = { info: jest.fn(), warn: jest.fn() };
  });

  test('set image uses fullImage including registry prefix', async () => {
    const fullImage = 'ghcr.io/myorg/myapp:v1';
    execaFn
      .mockResolvedValueOnce({ stdout: 'ghcr.io/myorg/myapp:old' }) // get current
      .mockResolvedValueOnce({ stdout: '' }); // set image

    const result = await syncKubernetesDeploymentImage({
      deploymentName: 'myapp',
      fullImage,
      kubectlArgs: (args) => args,
      getKubectlEnv: () => ({}),
      log,
      execaFn,
    });

    expect(result.setImage).toBe(true);
    expect(result.restarted).toBe(false);
    expect(execaFn).toHaveBeenCalledWith(
      'kubectl',
      ['set', 'image', 'deployment/myapp', `myapp=${fullImage}`],
      expect.any(Object)
    );
    expect(execaFn.mock.calls.some((c) => c[1]?.[0] === 'rollout')).toBe(false);
  });

  test('identical fullImage ref → set image no-op path then rollout restart', async () => {
    const fullImage = 'ghcr.io/myorg/myapp:v1';
    execaFn
      .mockResolvedValueOnce({ stdout: fullImage }) // get current === fullImage
      .mockResolvedValueOnce({ stdout: '' }) // set image (safe no-op)
      .mockResolvedValueOnce({ stdout: '' }); // rollout restart

    const result = await syncKubernetesDeploymentImage({
      deploymentName: 'myapp',
      fullImage,
      kubectlArgs: (args) => [...args, '--namespace', 'demo'],
      getKubectlEnv: () => ({ KUBECONFIG: '/tmp/config' }),
      log,
      execaFn,
    });

    expect(result.beforeImage).toBe(fullImage);
    expect(result.setImage).toBe(true);
    expect(result.restarted).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Image ref unchanged')
    );
    expect(execaFn).toHaveBeenNthCalledWith(
      2,
      'kubectl',
      ['set', 'image', 'deployment/myapp', `myapp=${fullImage}`, '--namespace', 'demo'],
      expect.any(Object)
    );
    expect(execaFn).toHaveBeenNthCalledWith(
      3,
      'kubectl',
      ['rollout', 'restart', 'deployment/myapp', '--namespace', 'demo'],
      expect.any(Object)
    );
  });

  test('same tag but different registry/name does not restart', async () => {
    execaFn
      .mockResolvedValueOnce({ stdout: 'docker.io/other/myapp:v1' })
      .mockResolvedValueOnce({ stdout: '' });

    const result = await syncKubernetesDeploymentImage({
      deploymentName: 'myapp',
      fullImage: 'ghcr.io/myorg/myapp:v1',
      kubectlArgs: (args) => args,
      getKubectlEnv: () => ({}),
      log,
      execaFn,
    });

    expect(result.restarted).toBe(false);
    expect(execaFn.mock.calls.some((c) => c[1]?.includes('restart'))).toBe(false);
  });

  test('set image failure is non-fatal and skips restart comparison safely', async () => {
    execaFn
      .mockResolvedValueOnce({ stdout: 'myapp:v1' })
      .mockRejectedValueOnce(new Error('not found'));

    const result = await syncKubernetesDeploymentImage({
      deploymentName: 'myapp',
      fullImage: 'myapp:v2',
      kubectlArgs: (args) => args,
      getKubectlEnv: () => ({}),
      log,
      execaFn,
    });

    expect(result.setImage).toBe(false);
    expect(result.restarted).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('kubectl set image skipped')
    );
  });
});

describe('explicit image tag warning', () => {
  test('createDockerImageDeployContext warns when DOCKER_IMAGE_TAG is explicit', () => {
    const log = { info: jest.fn(), warn: jest.fn(), success: jest.fn() };
    createDockerImageDeployContext(
      { project: 'myapp', version: '0.0.0' },
      { DOCKER_IMAGE_TAG: 'latest' },
      log
    );
    expect(log.warn).toHaveBeenCalledWith(EXPLICIT_IMAGE_TAG_WARNING);
    expect(resolveDockerImageRef({ project: 'myapp' }, { DOCKER_IMAGE_TAG: 'latest' }).tagSource).toBe(
      'explicit'
    );
  });

  test('createDockerImageDeployContext logs auto tag source when unset', () => {
    const log = { info: jest.fn(), warn: jest.fn(), success: jest.fn() };
    createDockerImageDeployContext(
      { project: 'myapp' },
      {},
      log
    );
    // May be git/ci/timestamp depending on environment; just assert no explicit warning
    expect(log.warn).not.toHaveBeenCalledWith(EXPLICIT_IMAGE_TAG_WARNING);
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/Using auto image tag/));
  });
});
