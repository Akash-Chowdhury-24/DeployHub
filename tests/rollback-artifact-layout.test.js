import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import { extractArtifact } from '../src/artifact/engine.js';
import {
  resolveDockerImageRefForTag,
  replaceDockerImageTag,
} from '../src/utils/docker-image.js';

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

describe('resolveDockerImageRefForTag', () => {
  test('forces tag to buildId and ignores DOCKER_IMAGE_TAG / git / CI', () => {
    const ref = resolveDockerImageRefForTag(
      { project: 'myapp' },
      {
        DOCKER_IMAGE_TAG: 'latest',
        GITHUB_SHA: 'deadbeef',
        DOCKER_IMAGE_NAME: 'myapp',
        DOCKER_REGISTRY_URL: 'ghcr.io',
      },
      '1.2.3-abc1234'
    );

    expect(ref.fullImage).toBe('ghcr.io/myapp:1.2.3-abc1234');
    expect(ref.imageTag).toBe('1.2.3-abc1234');
    expect(ref.tagSource).toBe('buildId');
  });

  test('replaceDockerImageTag handles registry:port paths', () => {
    expect(replaceDockerImageTag('localhost:5000/myapp:old', 'latest')).toBe(
      'localhost:5000/myapp:latest'
    );
    expect(replaceDockerImageTag('myapp', 'v2')).toBe('myapp:v2');
  });
});

describe('rollback artifact layout normalization', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-rollback-layout-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('extract into artifactDir leaves zip + top-level k8s manifests', async () => {
    const staging = path.join(tmp, 'staging');
    await fs.ensureDir(path.join(staging, 'k8s'));
    await fs.writeFile(path.join(staging, 'k8s', 'deployment.yaml'), 'apiVersion: apps/v1\n');
    await fs.writeJson(path.join(staging, 'metadata.json'), { project: 'demo' });

    const artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    const zipPath = path.join(artifactDir, 'artifact.zip');
    await createZip(staging, zipPath);

    await extractArtifact(artifactDir, artifactDir);

    expect(await fs.pathExists(zipPath)).toBe(true);
    expect(await fs.pathExists(path.join(artifactDir, 'k8s', 'deployment.yaml'))).toBe(true);
    expect(await fs.pathExists(path.join(artifactDir, 'metadata.json'))).toBe(true);
    expect(await fs.pathExists(path.join(artifactDir, '_extracted'))).toBe(false);

    const hasManifests =
      (await fs.pathExists(path.join(artifactDir, 'k8s'))) ||
      (await fs.readdir(artifactDir)).some((f) => /\.ya?ml$/.test(f));
    expect(hasManifests).toBe(true);
  });
});
