import {
  resolveBuildId,
  resolveUniqueBuildStamp,
  buildArtifactRemoteKey,
  legacyArtifactRemoteKey,
  highResBuildStamp,
} from '../src/utils/build-id.js';
import { resolveDockerImageRef } from '../src/utils/docker-image.js';

describe('buildId resolution', () => {
  test('unique stamps do not collide across two calls with different now', () => {
    const a = resolveUniqueBuildStamp({}, { getGitShortSha: () => null, now: () => new Date(2026, 6, 26, 17, 15, 48, 100) });
    const b = resolveUniqueBuildStamp({}, { getGitShortSha: () => null, now: () => new Date(2026, 6, 26, 17, 15, 48, 200) });
    expect(a.stamp).not.toBe(b.stamp);
  });

  test('resolveBuildId embeds semver and stamp', () => {
    const { buildId, semver } = resolveBuildId({
      semver: '1.0.6',
      getGitShortSha: () => 'abc1234',
    });
    expect(semver).toBe('1.0.6');
    expect(buildId).toBe('1.0.6-abc1234');
    expect(buildArtifactRemoteKey('myapp', buildId)).toBe(
      'myapp/builds/1.0.6-abc1234/artifact.zip'
    );
  });

  test('same package.json semver still yields different buildIds when stamp differs', () => {
    const first = resolveBuildId({
      semver: '0.0.0',
      getGitShortSha: () => null,
      now: () => new Date(2026, 6, 26, 10, 0, 0, 1),
    });
    const second = resolveBuildId({
      semver: '0.0.0',
      getGitShortSha: () => null,
      now: () => new Date(2026, 6, 26, 10, 0, 0, 2),
    });
    expect(first.buildId).not.toBe(second.buildId);
    expect(first.semver).toBe(second.semver);
  });

  test('image tag equals buildId when DOCKER_IMAGE_TAG unset and config.buildId set', () => {
    const { buildId } = resolveBuildId({ semver: '1.2.3', getGitShortSha: () => 'deadbee' });
    const ref = resolveDockerImageRef(
      { project: 'myapp', version: '1.2.3', buildId },
      { DOCKER_IMAGE_NAME: 'myuser/myapp' }
    );
    expect(ref.imageTag).toBe(buildId);
    expect(ref.tagSource).toBe('buildId');
    expect(ref.fullImage).toBe(`myuser/myapp:${buildId}`);
  });

  test('explicit DOCKER_IMAGE_TAG keeps image tag separate from buildId', () => {
    const ref = resolveDockerImageRef(
      { project: 'myapp', version: '1.2.3', buildId: '1.2.3-abc' },
      { DOCKER_IMAGE_NAME: 'myuser/myapp', DOCKER_IMAGE_TAG: 'latest' }
    );
    expect(ref.imageTag).toBe('latest');
    expect(ref.tagSource).toBe('explicit');
  });

  test('highResBuildStamp format', () => {
    expect(highResBuildStamp(new Date(2026, 6, 26, 17, 15, 48, 231))).toBe(
      '2026.07.26.1715-48231'
    );
  });

  test('legacy key shape preserved for read fallback docs', () => {
    expect(legacyArtifactRemoteKey('demo', '0.0.0')).toBe('demo/v0.0.0/artifact.zip');
  });
});
