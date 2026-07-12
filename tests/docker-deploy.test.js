import {
  describeInterpretedBackendGap,
  generateFrontendRuntimeDockerfile,
  generateSpringRuntimeDockerfile,
  isFrontendStaticFramework,
  isInterpretedBackendFramework,
  isNodeBackendFramework,
  resolveDockerImageRef,
} from '../src/utils/docker-image.js';
import { generateDockerignore } from '../src/utils/dockerfile.js';
import { ensureDockerfile, ensureDockerignore } from '../src/utils/scaffold.js';
import { getDeploymentSecretKeys } from '../src/deployment/deployment-env.js';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

describe('docker image naming', () => {
  test('resolveDockerImageRef uses DOCKER_IMAGE_NAME and version tag', () => {
    const ref = resolveDockerImageRef(
      { project: 'demo-react-project', version: '0.0.0' },
      { DOCKER_IMAGE_NAME: 'akashchowdhury/demo-react-project' }
    );

    expect(ref.fullImage).toBe('akashchowdhury/demo-react-project:0.0.0');
    expect(ref.latestImage).toBe('akashchowdhury/demo-react-project:latest');
    expect(ref.legacyLatestImage).toBe('demo-react-project:latest');
  });

  test('resolveDockerImageRef falls back to project name', () => {
    const ref = resolveDockerImageRef({ project: 'myapp' }, {});
    expect(ref.fullImage).toBe('myapp:latest');
  });

  test('generateFrontendRuntimeDockerfile copies pre-built output only', () => {
    const dockerfile = generateFrontendRuntimeDockerfile('dist');
    expect(dockerfile).toContain('FROM nginx:alpine');
    expect(dockerfile).toContain('COPY dist/ /usr/share/nginx/html/');
    expect(dockerfile).not.toContain('npm ci');
  });

  test('isInterpretedBackendFramework covers Python PHP and Ruby', () => {
    expect(isInterpretedBackendFramework('fastapi')).toBe(true);
    expect(isInterpretedBackendFramework('laravel')).toBe(true);
    expect(isInterpretedBackendFramework('rails')).toBe(true);
    expect(isInterpretedBackendFramework('spring')).toBe(false);
    expect(describeInterpretedBackendGap('fastapi').ecosystem).toBe('Python');
    expect(describeInterpretedBackendGap('laravel').ecosystem).toBe('PHP');
  });

  test('generateSpringRuntimeDockerfile copies jar only', () => {
    const dockerfile = generateSpringRuntimeDockerfile('target/app.jar', 8080);
    expect(dockerfile).toContain('COPY target/app.jar app.jar');
    expect(dockerfile).not.toContain('npm ci');
    expect(dockerfile).not.toContain('mvn');
  });
});

describe('dockerignore generation', () => {
  test('generateDockerignore excludes node_modules for React', () => {
    const content = generateDockerignore({
      projectType: 'frontend',
      framework: 'react',
      buildOutput: 'dist',
    });

    expect(content).toContain('node_modules');
    expect(content).toContain('.git');
    expect(content).toContain('dist');
    expect(content).toContain('.env');
  });

  test('ensureDockerignore does not overwrite existing file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-di-'));
    const ignorePath = path.join(tmpDir, '.dockerignore');
    await fs.writeFile(ignorePath, 'custom-ignore\n');

    const result = await ensureDockerignore(
      tmpDir,
      {
        project: 'app',
        projectType: 'frontend',
        framework: 'react',
        environments: { development: { type: 'docker' } },
      },
      { silent: true }
    );

    expect(result.generated).toBe(false);
    await expect(fs.readFile(ignorePath, 'utf-8')).resolves.toBe('custom-ignore\n');
    await fs.remove(tmpDir);
  });

  test('ensureDockerfile also generates .dockerignore when missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-df-di-'));

    const result = await ensureDockerfile(
      tmpDir,
      {
        project: 'app',
        projectType: 'frontend',
        framework: 'react',
        buildCommand: 'npm run build',
        buildOutput: 'dist',
        environments: { development: { type: 'docker' } },
      },
      { silent: true }
    );

    expect(result.generated).toBe(true);
    expect(result.dockerignoreGenerated).toBe(true);
    await expect(fs.pathExists(path.join(tmpDir, 'Dockerfile'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(tmpDir, '.dockerignore'))).resolves.toBe(true);

    const ignore = await fs.readFile(path.join(tmpDir, '.dockerignore'), 'utf-8');
    expect(ignore).toContain('node_modules');

    await fs.remove(tmpDir);
  });
});

describe('docker GitHub secrets checklist', () => {
  test('getDeploymentSecretKeys includes DOCKER_IMAGE_NAME and registry vars', () => {
    const keys = getDeploymentSecretKeys('docker');
    expect(keys).toContain('DOCKER_IMAGE_NAME');
    expect(keys).toContain('DOCKER_IMAGE_TAG');
    expect(keys).toContain('DOCKER_REGISTRY_USERNAME');
    expect(keys).toContain('DOCKER_REGISTRY_TOKEN');
    expect(keys).toContain('DOCKER_HOST');
  });
});
