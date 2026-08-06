import { resolveRollbackTarget } from '../src/utils/artifact-history.js';
import { getEnvMethod, getEnvSettings, mergeMethodSettingsIntoEnv } from '../src/core/environments.js';
import { resolveDockerImageRefForTag } from '../src/utils/docker-image.js';

/**
 * Per-provider: env-scoped history resolution must not cross-contaminate,
 * and method settings (host/namespace/image) come from that env's config.
 */
describe('per-provider env-scoped rollback resolution', () => {
  const methods = ['ssh', 'docker', 'ec2', 'azure-vm', 'gcp-vm', 'kubernetes'];

  test.each(methods)('%s: rollback target resolves only within calling env history', (method) => {
    const testingHistory = [
      { buildId: '1.0.0-test-new', semver: '1.0.0', uploadedAt: 't2', remoteKey: 'p/builds/1.0.0-test-new/artifact.zip' },
      { buildId: '1.0.0-test-old', semver: '1.0.0', uploadedAt: 't1', remoteKey: 'p/builds/1.0.0-test-old/artifact.zip' },
    ];
    const productionHistory = [
      { buildId: '2.0.0-prod-new', semver: '2.0.0', uploadedAt: 'p2', remoteKey: 'p/builds/2.0.0-prod-new/artifact.zip' },
      { buildId: '2.0.0-prod-old', semver: '2.0.0', uploadedAt: 'p1', remoteKey: 'p/builds/2.0.0-prod-old/artifact.zip' },
    ];

    const testRollback = resolveRollbackTarget(testingHistory);
    const prodRollback = resolveRollbackTarget(productionHistory);

    expect(testRollback.ok).toBe(true);
    expect(prodRollback.ok).toBe(true);
    expect(testRollback.entry.buildId).toBe('1.0.0-test-old');
    expect(prodRollback.entry.buildId).toBe('2.0.0-prod-old');
    expect(testRollback.entry.buildId).not.toBe(prodRollback.entry.buildId);

    // Exact buildId in one env must not resolve from the other env's list
    expect(resolveRollbackTarget(testingHistory, '2.0.0-prod-old').ok).toBe(false);
    expect(resolveRollbackTarget(productionHistory, '1.0.0-test-old').ok).toBe(false);

    // Method wiring sanity: env entry method matches
    const entry = {
      enabled: true,
      method,
      trigger: 'manual',
      config:
        method === 'kubernetes'
          ? { kubeNamespace: `${method}-ns`, dockerImageName: 'org/app' }
          : method === 'docker'
            ? { dockerImageName: 'org/app' }
            : { host: '10.0.0.1', user: 'deploy' },
    };
    expect(getEnvMethod(entry)).toBe(method);
    const settings = getEnvSettings(entry);
    if (method === 'kubernetes') {
      expect(settings.kubeNamespace).toBe('kubernetes-ns');
    }
    if (method === 'docker' || method === 'kubernetes') {
      const merged = mergeMethodSettingsIntoEnv({}, settings);
      const ref = resolveDockerImageRefForTag(
        { project: 'app' },
        merged,
        testRollback.entry.buildId
      );
      expect(ref.fullImage).toContain(testRollback.entry.buildId);
      expect(ref.imageTag).toBe(testRollback.entry.buildId);
    }
  });

  test('kubectl rollout undo stays removed (artifact-based rollback only)', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.join(process.cwd(), 'src/deployment/providers/kubernetes.js'),
      'utf8'
    );
    expect(src).not.toMatch(/rollout\s+undo/);
    expect(src).toMatch(/skipImageReuse:\s*true/);
  });
});
