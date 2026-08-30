/**
 * Real registry pull on rollback (fresh/CI runner: image not in the local cache).
 * Uses a local registry:2 (Docker Hub equivalent) so we can push an exact
 * buildId tag, delete the local copy, and prove `ensureImageReadyForDeploy`
 * pulls that tag — the same helper docker.js and kubernetes.js rollback call.
 *
 * describe.skip when Docker is unavailable.
 */
import { jest } from '@jest/globals';
import { execa } from 'execa';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import { createDockerImageDeployContext } from '../src/utils/docker-image-deploy.js';
import { resolveDockerImageRefForTag } from '../src/utils/docker-image.js';
import { createKubernetesProvider } from '../src/deployment/providers/kubernetes.js';

const REGISTRY_CONTAINER = 'deployhub-test-rollback-registry';
const REGISTRY_PORT = 15951;
const BUILD_ID = '2026.08.30.1557-4dc1fc4';
const IMAGE_REPO = `127.0.0.1:${REGISTRY_PORT}/dh-rollback-ci`;
const IMAGE_REF = `${IMAGE_REPO}:${BUILD_ID}`;
const MISSING_REF = `${IMAGE_REPO}:never-pushed-zzzz`;

/** @returns {Promise<boolean>} */
async function dockerAvailable() {
  try {
    await execa('docker', ['info'], { timeout: 20000 });
    return true;
  } catch (err) {
    console.warn(
      'Docker unavailable — skipping real rollback registry-pull tests:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

const dockerOk = await dockerAvailable();

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
async function seedPythonArtifact(artifactDir) {
  const staging = path.join(artifactDir, '_staging');
  await fs.ensureDir(path.join(staging, 'k8s'));
  await fs.writeFile(
    path.join(staging, 'k8s', 'deployment.yaml'),
    'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n'
  );
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
  await fs.copy(path.join(staging, 'k8s'), path.join(artifactDir, 'k8s'));
  await fs.remove(staging);
}

/**
 * @param {string} artifactDir
 */
async function seedGoArtifact(artifactDir) {
  const staging = path.join(artifactDir, '_staging');
  await fs.ensureDir(path.join(staging, 'bin'));
  await fs.writeFile(path.join(staging, 'bin', 'app'), '#!/bin/sh\necho go\n');
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

function mockLog() {
  /** @type {string[]} */
  const messages = [];
  return {
    messages,
    info: (m) => {
      const s = String(m);
      messages.push(s);
      console.log('[docker]', s);
    },
    warn: (m) => {
      const s = String(m);
      messages.push(s);
      console.log('[docker]', s);
    },
    success: (m) => {
      const s = String(m);
      messages.push(s);
      console.log('[docker]', s);
    },
  };
}

(dockerOk ? describe : describe.skip)('rollback registry pull (real Docker)', () => {
  jest.setTimeout(180000);

  /** @type {string} */
  let tmp;

  beforeAll(async () => {
    await execa('docker', ['rm', '-f', REGISTRY_CONTAINER]).catch(() => {});
    await execa('docker', [
      'run',
      '-d',
      '--name',
      REGISTRY_CONTAINER,
      '-p',
      `${REGISTRY_PORT}:5000`,
      'registry:2',
    ]);
    await new Promise((r) => setTimeout(r, 2500));
    await execa('docker', ['pull', 'hello-world:latest']);
    await execa('docker', ['tag', 'hello-world:latest', IMAGE_REF]);
    const pushed = await execa('docker', ['push', IMAGE_REF]);
    console.log('--- docker push (seed registry) ---\n', pushed.stdout || pushed.stderr);
    await execa('docker', ['rmi', '-f', IMAGE_REF]).catch(() => {});
  });

  afterAll(async () => {
    await execa('docker', ['rmi', '-f', IMAGE_REF]).catch(() => {});
    await execa('docker', ['rm', '-f', REGISTRY_CONTAINER]).catch(() => {});
  });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-rollback-reg-'));
    await execa('docker', ['rmi', '-f', IMAGE_REF]).catch(() => {});
  });

  afterEach(async () => {
    await fs.remove(tmp).catch(() => {});
  });

  test('1. CI-style: no local image, tag in registry — pull succeeds (docker + k8s shared helper)', async () => {
    const inspectBefore = await execa('docker', ['image', 'inspect', IMAGE_REF], {
      reject: false,
    });
    expect(inspectBefore.exitCode).not.toBe(0);

    const artifactDir = path.join(tmp, 'artifact');
    await seedPythonArtifact(artifactDir);

    const config = {
      project: 'demo-fastapi-project',
      projectType: 'backend',
      framework: 'fastapi',
    };
    const env = {
      DOCKER_IMAGE_NAME: IMAGE_REPO,
      DOCKER_IMAGE_TAG: 'eaa8b0d',
    };
    const rollbackImage = resolveDockerImageRefForTag(config, env, BUILD_ID).fullImage;
    expect(rollbackImage).toBe(IMAGE_REF);

    const log = mockLog();
    // Identical call kubernetes.js / docker.js rollback make:
    const imageOps = createDockerImageDeployContext(config, env, log);
    const result = await imageOps.ensureImageReadyForDeploy(artifactDir, {
      fullImage: rollbackImage,
      skipImageReuse: true,
      skipPush: true,
    });

    expect(result.fullImage).toBe(IMAGE_REF);
    const joined = log.messages.join('\n');
    expect(joined).toMatch(/Pulling /);
    expect(joined).toMatch(new RegExp(BUILD_ID));
    expect(joined).toMatch(/Pulled /);
    expect(joined).not.toMatch(/Cannot rebuild Python/);

    const inspectAfter = await execa('docker', ['image', 'inspect', IMAGE_REF]);
    expect(inspectAfter.exitCode ?? 0).toBe(0);
    console.log('--- docker pull evidence (log) ---\n', joined);
  });

  test('2. image missing locally AND in registry — Python rebuild refusal names the pull', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await seedPythonArtifact(artifactDir);

    const log = mockLog();
    const ctx = createDockerImageDeployContext(
      { project: 'demo-fastapi-project', projectType: 'backend', framework: 'fastapi' },
      { DOCKER_IMAGE_NAME: IMAGE_REPO, DOCKER_IMAGE_TAG: 'eaa8b0d' },
      log
    );

    await expect(
      ctx.ensureImageReadyForDeploy(artifactDir, {
        fullImage: MISSING_REF,
        skipImageReuse: true,
        skipPush: true,
      })
    ).rejects.toThrow(
      /Target image .*never-pushed-zzzz not found locally and could not be pulled from the registry \(not found\)[\s\S]*Cannot rebuild Python backend image/
    );
    console.log('--- pull-miss refusal ---\n', log.messages.join('\n'));
  });

  test('3. compiled Go backend: local+registry miss still rebuilds from artifact', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await seedGoArtifact(artifactDir);
    const goRef = `${IMAGE_REPO}:go-rebuild-never-pushed`;
    await execa('docker', ['rmi', '-f', goRef]).catch(() => {});

    const log = mockLog();
    const ctx = createDockerImageDeployContext(
      { project: 'go-api', projectType: 'backend', framework: 'go' },
      { DOCKER_IMAGE_NAME: IMAGE_REPO },
      log
    );

    const result = await ctx.ensureImageReadyForDeploy(artifactDir, {
      fullImage: goRef,
      skipImageReuse: true,
      skipPush: true,
    });

    expect(result.fullImage).toBe(goRef);
    const joined = log.messages.join('\n');
    expect(joined).toMatch(/could not be pulled from the registry/);
    expect(joined).toMatch(/Building runtime image from pre-built Go binary/);
    await execa('docker', ['image', 'inspect', goRef]);
    await execa('docker', ['rmi', '-f', goRef]).catch(() => {});
    console.log('--- go rebuild evidence ---\n', joined);
  });

  test('4. Kubernetes rollback wiring: same helper + skipImageReuse; python would refuse without pull', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    await seedPythonArtifact(artifactDir);

    const config = {
      project: 'demo-fastapi-project',
      projectType: 'backend',
      framework: 'fastapi',
    };
    const env = {
      DOCKER_IMAGE_NAME: IMAGE_REPO,
      DOCKER_IMAGE_TAG: 'eaa8b0d',
    };
    const rollbackImage = resolveDockerImageRefForTag(config, env, BUILD_ID).fullImage;
    const log = mockLog();
    const imageOps = createDockerImageDeployContext(config, env, log);
    // kubernetes.js: imageOps.ensureImageReadyForDeploy(artifactDir, { fullImage, skipImageReuse: true })
    await imageOps.ensureImageReadyForDeploy(artifactDir, {
      fullImage: rollbackImage,
      skipImageReuse: true,
      skipPush: true,
    });
    expect(log.messages.join('\n')).toMatch(/Pulled /);

    const k8sSrc = await fs.readFile(
      path.join(process.cwd(), 'src/deployment/providers/kubernetes.js'),
      'utf8'
    );
    expect(k8sSrc).toContain('createDockerImageDeployContext');
    expect(k8sSrc).toMatch(/skipImageReuse:\s*true/);
    expect(typeof createKubernetesProvider).toBe('function');
  });
});
