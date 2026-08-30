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

const { createDockerImageDeployContext, classifyDockerPullFailure, formatImageNotLocalAndPullFailed } =
  await import('../src/utils/docker-image-deploy.js');
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

async function seedPythonArtifact(artifactDir) {
  const staging = path.join(artifactDir, '_staging');
  await fs.ensureDir(staging);
  await fs.writeFile(path.join(staging, 'main.py'), 'print("ok")\n');
  await fs.writeFile(path.join(staging, 'requirements.txt'), 'fastapi\n');
  await fs.writeFile(
    path.join(staging, 'Dockerfile'),
    'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nCMD ["uvicorn", "main:app"]\n'
  );
  await fs.writeJson(path.join(staging, 'metadata.json'), {
    projectType: 'backend',
    framework: 'fastapi',
    buildOutput: '.',
    port: 8000,
  });
  await fs.ensureDir(artifactDir);
  await createZip(staging, path.join(artifactDir, 'artifact.zip'));
  await fs.remove(staging);
}

/**
 * @param {string} artifactDir
 */
async function seedGoArtifact(artifactDir) {
  const staging = path.join(artifactDir, '_staging');
  await fs.ensureDir(path.join(staging, 'bin'));
  await fs.writeFile(path.join(staging, 'bin', 'app'), 'fake-go-binary');
  await fs.writeJson(path.join(staging, 'metadata.json'), {
    projectType: 'backend',
    framework: 'go',
    buildOutput: 'bin',
    port: 8080,
  });
  await fs.ensureDir(artifactDir);
  await createZip(staging, path.join(artifactDir, 'artifact.zip'));
  await fs.remove(staging);
}

/**
 * @param {{ local?: string[], pullable?: string[] }} [opts]
 */
function installDockerMock(opts = {}) {
  const present = new Set(opts.local || []);
  const registry = new Set(opts.pullable || []);
  mockExeca.mockImplementation(async (cmd, args = []) => {
    if (await runRealExtractIfNeeded(cmd, args)) {
      return { stdout: '' };
    }
    if (cmd !== 'docker') return { stdout: '' };
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!present.has(args[2])) {
        throw new Error('No such image');
      }
      return { stdout: '{}' };
    }
    if (args[0] === 'pull') {
      const ref = args[1];
      if (!registry.has(ref)) {
        const err = new Error(`Unable to find image '${ref}' locally`);
        err.stderr = `Error response from daemon: manifest unknown: ${ref}`;
        throw err;
      }
      present.add(ref);
      return { stdout: `Status: Downloaded newer image for ${ref}` };
    }
    return { stdout: '' };
  });
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
  jest.setTimeout(30000);

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

  test('skipImageReuse reuses exact restored tag when present (no :latest retag)', async () => {
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
    expect(inspectCalls.length).toBeGreaterThanOrEqual(1);
    expect(inspectCalls[0][1]).toEqual(['image', 'inspect', restored]);

    const buildCalls = mockExeca.mock.calls.filter(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'build'
    );
    expect(buildCalls).toHaveLength(0);

    const tagCalls = mockExeca.mock.calls.filter(
      (c) =>
        c[0] === 'docker' &&
        c[1]?.[0] === 'tag' &&
        c[1]?.[1] === 'myapp:current-live-tag'
    );
    expect(tagCalls).toHaveLength(0);

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Using restored image')
    );
  });

  test('skipImageReuse pulls exact tag from registry when missing locally (no rebuild)', async () => {
    const restored = 'myapp:1.0.0-restored123';
    installDockerMock({ local: [], pullable: [restored] });

    const artifactDir = path.join(tmp, 'artifact');
    await seedFrontendArtifact(artifactDir);

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
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['pull', restored],
      expect.any(Object)
    );
    const buildCalls = mockExeca.mock.calls.filter(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'build'
    );
    expect(buildCalls).toHaveLength(0);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining(`Pulled ${restored}`));
  });

  test('skipImageReuse rebuilds from artifact when local miss AND registry pull fails', async () => {
    const restored = 'myapp:1.0.0-restored123';
    installDockerMock({ local: [], pullable: [] });

    const artifactDir = path.join(tmp, 'artifact');
    await seedFrontendArtifact(artifactDir);

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
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['pull', restored],
      expect.any(Object)
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['build', '-t', restored, '.'],
      expect.objectContaining({ cwd: expect.stringContaining('_docker_build') })
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('not found locally and could not be pulled')
    );
  });

  test('interpreted backend: pull miss then rebuild refusal names registry pull', async () => {
    const restored = 'org/api:2026.08.30.1557-4dc1fc4';
    installDockerMock({ local: [], pullable: [] });

    const artifactDir = path.join(tmp, 'artifact');
    await seedPythonArtifact(artifactDir);

    const ctx = createDockerImageDeployContext(
      { project: 'api', projectType: 'backend', framework: 'fastapi' },
      { DOCKER_IMAGE_NAME: 'org/api', DOCKER_IMAGE_TAG: 'eaa8b0d' },
      log
    );

    await expect(
      ctx.ensureImageReadyForDeploy(artifactDir, {
        fullImage: restored,
        skipImageReuse: true,
      })
    ).rejects.toThrow(
      /Target image org\/api:2026\.08\.30\.1557-4dc1fc4 not found locally and could not be pulled from the registry \(not found\)[\s\S]*Cannot rebuild Python backend image "org\/api:2026\.08\.30\.1557-4dc1fc4"/
    );
  });

  test('compiled Go backend: pull miss still rebuilds from artifact binary', async () => {
    const restored = 'org/api:0.1.0-old';
    installDockerMock({ local: [], pullable: [] });

    const artifactDir = path.join(tmp, 'artifact');
    await seedGoArtifact(artifactDir);

    const ctx = createDockerImageDeployContext(
      { project: 'api', projectType: 'backend', framework: 'go' },
      { DOCKER_IMAGE_NAME: 'org/api' },
      log
    );

    const result = await ctx.ensureImageReadyForDeploy(artifactDir, {
      fullImage: restored,
      skipImageReuse: true,
    });

    expect(result.fullImage).toBe(restored);
    expect(mockExeca).toHaveBeenCalledWith('docker', ['pull', restored], expect.any(Object));
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['build', '-t', restored, '.'],
      expect.objectContaining({ cwd: expect.stringContaining('_docker_build') })
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('Building runtime image from pre-built Go binary')
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
  jest.setTimeout(30000);
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    jest.resetAllMocks();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-docker-provider-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('rollback pulls restored buildId from registry when not local (no rebuild)', async () => {
    const restored = 'org/myapp:0.1.0-oldbuild';
    installDockerMock({ local: [], pullable: [restored] });

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
      ['pull', restored],
      expect.any(Object)
    );
    const buildCalls = mockExeca.mock.calls.filter(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'build'
    );
    expect(buildCalls).toHaveLength(0);
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['run', '-d', '--rm', '--name', 'myapp', restored],
      expect.any(Object)
    );
  });

  test('rollback requires buildId', async () => {
    const provider = createDockerProvider({ project: 'myapp' }, 'production', {});
    await expect(provider.rollback(path.join(tmp, 'empty'), {})).rejects.toThrow(
      /requires buildId/
    );
  });

  test('rollback uses each environment config dockerImageName in docker pull/run', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await seedFrontendArtifact(artifactDir);

    const config = {
      project: 'myapp',
      projectType: 'frontend',
      framework: 'react',
      environments: {
        testing: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: { dockerImageName: 'org/testing-app' },
        },
        production: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: { dockerImageName: 'org/production-app' },
        },
      },
    };

    installDockerMock({ local: [], pullable: ['org/production-app:0.1.0-prod'] });

    const productionProvider = createDockerProvider(config, 'production', {});
    await productionProvider.rollback(artifactDir, {
      buildId: '0.1.0-prod',
      semver: '0.1.0',
      remoteKey: 'myapp/builds/0.1.0-prod/artifact.zip',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['pull', 'org/production-app:0.1.0-prod'],
      expect.any(Object)
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['run', '-d', '--rm', '--name', 'myapp-production', 'org/production-app:0.1.0-prod'],
      expect.any(Object)
    );

    jest.clearAllMocks();
    installDockerMock({ local: [], pullable: ['org/testing-app:0.1.0-test'] });

    const testingProvider = createDockerProvider(config, 'testing', {});
    await testingProvider.rollback(artifactDir, {
      buildId: '0.1.0-test',
      semver: '0.1.0',
      remoteKey: 'myapp/builds/0.1.0-test/artifact.zip',
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['pull', 'org/testing-app:0.1.0-test'],
      expect.any(Object)
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['run', '-d', '--rm', '--name', 'myapp-testing', 'org/testing-app:0.1.0-test'],
      expect.any(Object)
    );
  });
});

describe('classifyDockerPullFailure', () => {
  test('maps daemon errors to not found / auth failed / network error', () => {
    expect(
      classifyDockerPullFailure({ stderr: 'Error response from daemon: manifest unknown' })
    ).toBe('not found');
    expect(
      classifyDockerPullFailure({
        stderr:
          'pull access denied for x, repository does not exist or may require docker login',
      })
    ).toBe('not found');
    expect(
      classifyDockerPullFailure({ stderr: 'unauthorized: authentication required' })
    ).toBe('auth failed');
    expect(classifyDockerPullFailure({ message: 'dial tcp: i/o timeout' })).toBe(
      'network error'
    );
    expect(
      formatImageNotLocalAndPullFailed('org/app:tag', 'not found')
    ).toBe(
      'Target image org/app:tag not found locally and could not be pulled from the registry (not found).'
    );
  });
});

describe('SSH/EC2/VM rollback does not use docker image resolution', () => {
  test('ssh, ec2, azure-vm, gcp-vm sources never import docker-image-deploy', async () => {
    const { readFileSync } = await import('node:fs');
    const files = [
      'src/deployment/providers/ssh.js',
      'src/deployment/providers/ec2.js',
      'src/deployment/providers/azure-vm.js',
      'src/deployment/providers/gcp-vm.js',
    ];
    for (const file of files) {
      const src = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(src).not.toMatch(/docker-image-deploy/);
      expect(src).not.toMatch(/ensureImageReadyForDeploy/);
      expect(src).not.toMatch(/skipImageReuse/);
    }
    const ssh = readFileSync(
      path.join(process.cwd(), 'src/deployment/providers/ssh.js'),
      'utf8'
    );
    expect(ssh).toMatch(/await deploy\(artifactDir\)/);
  });
});

describe('rollback reuses deploy run + verify port-publish', () => {
  test('docker.js rollback only calls deploy() — no separate docker run / deployOverSsh', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      path.join(process.cwd(), 'src/deployment/providers/docker.js'),
      'utf8'
    );
    const start = src.indexOf('async function rollback');
    const end = src.indexOf('async function healthCheck');
    const rollbackFn = src.slice(start, end);
    expect(rollbackFn).toMatch(/await deploy\(artifactDir,/);
    expect(rollbackFn).toMatch(/skipImageReuse:\s*true/);
    expect(rollbackFn).not.toMatch(/deployOverSsh/);
    expect(rollbackFn).not.toMatch(/buildRemoteDockerCommands/);
    expect(rollbackFn).not.toMatch(/docker run/);
    expect(src).toMatch(/await deployOverSsh\(imageRef, publishPort\)/);
    expect(src).toMatch(/runArgs\.push\('-p',/);
  });

  test('rollback engine uses runDockerPortPublishChecksForEnvs (same as deploy verify stage)', async () => {
    const { readFileSync } = await import('node:fs');
    const engine = readFileSync(
      path.join(process.cwd(), 'src/utils/rollback/engine.js'),
      'utf8'
    );
    const deployCmd = readFileSync(
      path.join(process.cwd(), 'src/commands/deploy.js'),
      'utf8'
    );
    expect(engine).toContain('runDockerPortPublishChecksForEnvs');
    expect(engine).toMatch(/requireRunning:\s*true/);
    expect(deployCmd).toContain('runDockerPortPublishChecksForEnvs');
    expect(deployCmd).toMatch(/requireRunning:\s*true/);
  });
});
