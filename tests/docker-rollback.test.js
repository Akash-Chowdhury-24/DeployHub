import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const mockExeca = jest.fn();
jest.unstable_mockModule('execa', () => ({
  execa: mockExeca,
  default: mockExeca,
}));

const { createDockerImageDeployContext } = await import('../src/utils/docker-image-deploy.js');
const { createDockerProvider } = await import('../src/deployment/providers/docker.js');

/**
 * @param {string} sourceDir
 * @param {string} zipPath
 */
function createZip(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * @param {string} artifactDir
 */
async function seedFrontendArtifact(artifactDir) {
  const staging = path.join(artifactDir, '_staging');
  await fs.ensureDir(path.join(staging, 'dist'));
  await fs.writeFile(path.join(staging, 'dist', 'index.html'), '<html></html>');
  await fs.writeJson(path.join(staging, 'metadata.json'), {
    projectType: 'frontend',
    framework: 'react',
    buildOutput: 'dist',
  });
  await fs.ensureDir(artifactDir);
  await createZip(staging, path.join(artifactDir, 'artifact.zip'));
  await fs.remove(staging);
}

/**
 * Real extract for artifact.zip — docker-image-deploy uses execa for unzip.
 * @param {string} cmd
 * @param {string[]} args
 */
async function runRealExtractIfNeeded(cmd, args) {
  if (cmd === 'powershell' || cmd === 'unzip') {
    await execFileAsync(cmd, args, { windowsHide: true });
    return true;
  }
  return false;
}

describe('ensureImageReadyForDeploy rollback options', () => {
  /** @type {string} */
  let tmp;
  /** @type {{ info: jest.Mock, warn: jest.Mock, success: jest.Mock }} */
  let log;

  beforeEach(async () => {
    jest.resetAllMocks();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-docker-rollback-'));
    log = { info: jest.fn(), warn: jest.fn(), success: jest.fn() };

    mockExeca.mockImplementation(async (cmd, args = []) => {
      if (await runRealExtractIfNeeded(cmd, args)) {
        return { stdout: '' };
      }
      if (cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
        // Pretend current pipeline image always exists locally
        return { stdout: '{}' };
      }
      return { stdout: '' };
    });
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('skipImageReuse forces rebuild even when local image exists', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await seedFrontendArtifact(artifactDir);

    const restored = 'myapp:1.0.0-restored123';
    const ctx = createDockerImageDeployContext(
      { project: 'myapp', projectType: 'frontend', framework: 'react' },
      { DOCKER_IMAGE_TAG: 'current-live-tag' },
      log
    );

    const result = await ctx.ensureImageReadyForDeploy(artifactDir, {
      fullImage: restored,
      skipImageReuse: true,
    });

    expect(result.fullImage).toBe(restored);
    expect(result.ranCompose).toBe(false);

    const inspectCalls = mockExeca.mock.calls.filter(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'image' && c[1]?.[1] === 'inspect'
    );
    expect(inspectCalls).toHaveLength(0);

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['build', '-t', restored, '.'],
      expect.objectContaining({ cwd: expect.stringContaining('_docker_build') })
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping local image reuse')
    );
  });

  test('without skipImageReuse, reuses matching local image and skips build', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await seedFrontendArtifact(artifactDir);

    const ctx = createDockerImageDeployContext(
      { project: 'myapp', projectType: 'frontend' },
      { DOCKER_IMAGE_TAG: 'reuse-me' },
      log
    );

    await ctx.ensureImageReadyForDeploy(artifactDir);

    const buildCalls = mockExeca.mock.calls.filter(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'build'
    );
    expect(buildCalls).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Reusing existing image myapp:reuse-me')
    );
  });
});

describe('docker provider rollback', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    jest.resetAllMocks();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-docker-provider-'));
    mockExeca.mockImplementation(async (cmd, args = []) => {
      if (await runRealExtractIfNeeded(cmd, args)) {
        return { stdout: '' };
      }
      return { stdout: '' };
    });
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('rollback tags with restored buildId and skips image reuse', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await seedFrontendArtifact(artifactDir);

    const provider = createDockerProvider(
      { project: 'myapp', projectType: 'frontend', framework: 'react' },
      'production',
      { DOCKER_IMAGE_TAG: 'should-not-win', DOCKER_IMAGE_NAME: 'org/myapp' }
    );

    await provider.rollback(artifactDir, {
      buildId: '0.1.0-oldbuild',
      semver: '0.1.0',
      remoteKey: 'myapp/builds/0.1.0-oldbuild/artifact.zip',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['build', '-t', 'org/myapp:0.1.0-oldbuild', '.'],
      expect.any(Object)
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['run', '-d', '--rm', '--name', 'myapp', 'org/myapp:0.1.0-oldbuild'],
      expect.any(Object)
    );

    const inspectCalls = mockExeca.mock.calls.filter(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'image' && c[1]?.[1] === 'inspect'
    );
    expect(inspectCalls).toHaveLength(0);
  });

  test('rollback requires buildId', async () => {
    const provider = createDockerProvider({ project: 'myapp' }, 'production', {});
    await expect(provider.rollback(path.join(tmp, 'empty'), {})).rejects.toThrow(
      /requires buildId/
    );
  });
});
