import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import {
  generateKubernetesManifests,
  hasKubernetesManifests,
  resolveKubernetesManifestOptions,
  sanitizeK8sName,
} from '../src/utils/kubernetes-manifests.js';
import {
  ensureDockerfile,
  ensureKubernetesManifests,
} from '../src/utils/scaffold.js';

describe('kubernetes manifest generation', () => {
  test('sanitizeK8sName lowercases and replaces invalid characters', () => {
    expect(sanitizeK8sName('My App!')).toBe('my-app');
  });

  test('generateKubernetesManifests includes optional imagePullSecret', () => {
    const { deploymentYaml } = generateKubernetesManifests({
      appName: 'my-app',
      imageName: 'ghcr.io/org/app',
      port: 3000,
      namespace: 'production',
      imagePullSecret: 'regcred',
    });

    expect(deploymentYaml).toContain('imagePullSecrets:');
    expect(deploymentYaml).toContain('name: regcred');
    expect(deploymentYaml).toContain('replicas: 1');
    expect(deploymentYaml).toContain('containerPort: 3000');
  });

  test('generateKubernetesManifests omits imagePullSecret when not configured', () => {
    const { deploymentYaml } = generateKubernetesManifests({
      appName: 'my-app',
      imageName: 'ghcr.io/org/app',
      port: 3000,
      namespace: 'production',
    });

    expect(deploymentYaml).not.toContain('imagePullSecrets:');
  });

  test('generateKubernetesManifests uses explicit imageTag instead of hardcoded latest', () => {
    const { deploymentYaml } = generateKubernetesManifests({
      appName: 'my-app',
      imageName: 'ghcr.io/org/app',
      imageTag: '1.2.3',
      port: 3000,
      namespace: 'production',
    });

    expect(deploymentYaml).toContain('image: ghcr.io/org/app:1.2.3');
    expect(deploymentYaml).toContain(
      '# Image tag is overwritten at deploy time (kubectl set image uses the resolved build tag)'
    );
    expect(deploymentYaml).not.toContain('image: ghcr.io/org/app:latest');
  });

  test('resolveKubernetesManifestOptions prefers DOCKER_IMAGE_TAG env var', () => {
    const previous = process.env.DOCKER_IMAGE_TAG;
    process.env.DOCKER_IMAGE_TAG = 'v2.0.0';

    try {
      const options = resolveKubernetesManifestOptions(
        { project: 'my-app', version: '1.0.0' },
        { production: { type: 'kubernetes', dockerImageName: 'ghcr.io/org/app' } }
      );
      expect(options.imageTag).toBe('v2.0.0');
    } finally {
      if (previous === undefined) {
        delete process.env.DOCKER_IMAGE_TAG;
      } else {
        process.env.DOCKER_IMAGE_TAG = previous;
      }
    }
  });

  test('resolveKubernetesManifestOptions falls back to config.version then latest', () => {
    const previous = process.env.DOCKER_IMAGE_TAG;
    delete process.env.DOCKER_IMAGE_TAG;

    try {
      expect(
        resolveKubernetesManifestOptions(
          { project: 'my-app', version: '1.4.2' },
          { production: { type: 'kubernetes' } }
        ).imageTag
      ).toBe('1.4.2');

      expect(
        resolveKubernetesManifestOptions(
          { project: 'my-app' },
          { production: { type: 'kubernetes' } }
        ).imageTag
      ).toBe('latest');
    } finally {
      if (previous !== undefined) {
        process.env.DOCKER_IMAGE_TAG = previous;
      }
    }
  });

  test('hasKubernetesManifests detects k8s directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-k8s-'));
    await fs.ensureDir(path.join(tmpDir, 'k8s'));
    await fs.writeFile(path.join(tmpDir, 'k8s', 'deployment.yaml'), 'apiVersion: v1\n');

    await expect(hasKubernetesManifests(tmpDir)).resolves.toBe(true);
    await fs.remove(tmpDir);
  });

  test('hasKubernetesManifests detects root-level kubernetes yaml', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-k8s-'));
    await fs.writeFile(
      path.join(tmpDir, 'deployment.yaml'),
      'apiVersion: apps/v1\nkind: Deployment\n'
    );

    await expect(hasKubernetesManifests(tmpDir)).resolves.toBe(true);
    await fs.remove(tmpDir);
  });
});

describe('scaffold ensure helpers', () => {
  test('ensureDockerfile does not overwrite existing Dockerfile', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-docker-'));
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    await fs.writeFile(dockerfilePath, 'FROM scratch\n');

    const result = await ensureDockerfile(
      tmpDir,
      {
        project: 'test-app',
        projectType: 'backend',
        framework: 'express',
        environments: { production: { type: 'docker' } },
      },
      { silent: true }
    );

    expect(result.generated).toBe(false);
    await expect(fs.readFile(dockerfilePath, 'utf-8')).resolves.toBe('FROM scratch\n');
    await fs.remove(tmpDir);
  });

  test('ensureKubernetesManifests does not overwrite existing manifests', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-k8s-existing-'));
    await fs.ensureDir(path.join(tmpDir, 'k8s'));
    await fs.writeFile(path.join(tmpDir, 'k8s', 'deployment.yaml'), 'apiVersion: v1\nkind: Deployment\n');

    const result = await ensureKubernetesManifests(
      tmpDir,
      {
        project: 'test-app',
        environments: { production: { type: 'kubernetes' } },
      },
      { production: { type: 'kubernetes' } },
      { silent: true }
    );

    expect(result.generated).toBe(false);
    await expect(fs.readFile(path.join(tmpDir, 'k8s', 'deployment.yaml'), 'utf-8')).resolves.toBe(
      'apiVersion: v1\nkind: Deployment\n'
    );
    await fs.remove(tmpDir);
  });

  test('ensureDockerfile generates when missing for docker deploy', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-docker-gen-'));

    const result = await ensureDockerfile(
      tmpDir,
      {
        project: 'test-app',
        projectType: 'backend',
        framework: 'express',
        startCommand: 'npm start',
        port: 3000,
        environments: { production: { type: 'docker' } },
      },
      { silent: true }
    );

    expect(result.generated).toBe(true);
    await expect(fs.pathExists(path.join(tmpDir, 'Dockerfile'))).resolves.toBe(true);
    await fs.remove(tmpDir);
  });

  test('ensureKubernetesManifests generates k8s directory when missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-k8s-gen-'));

    const result = await ensureKubernetesManifests(
      tmpDir,
      {
        project: 'test-app',
        projectType: 'backend',
        framework: 'express',
        port: 3000,
        environments: {
          production: {
            type: 'kubernetes',
            dockerImageName: 'ghcr.io/org/app',
            kubeNamespace: 'production',
          },
        },
      },
      {
        production: {
          type: 'kubernetes',
          dockerImageName: 'ghcr.io/org/app',
          kubeNamespace: 'production',
        },
      },
      { silent: true }
    );

    expect(result.generated).toBe(true);
    await expect(fs.pathExists(path.join(tmpDir, 'k8s', 'deployment.yaml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(tmpDir, 'k8s', 'service.yaml'))).resolves.toBe(true);
    await fs.remove(tmpDir);
  });
});
