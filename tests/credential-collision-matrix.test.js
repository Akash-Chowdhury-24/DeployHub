/**
 * Exhaustive storage × deployment credential collision matrix.
 * Fails if any storage provider's runtime env keys overlap any deployment
 * method's declared env keys — catches regressions when new providers/methods
 * are added without checking the full cross product.
 */
import {
  STORAGE_PROVIDER_ORDER,
  DEPLOYMENT_METHOD_ORDER,
  STORAGE_RUNTIME_ENV_KEYS,
  STORAGE_RUNTIME_EXTRAS,
  DEPLOYMENT_RUNTIME_ENV_KEYS,
  SHARED_BY_DESIGN_DEPLOY_PAIRS,
  buildStorageDeployOverlapMatrix,
  listStorageDeployCollisions,
  listDeployDeployShares,
  intersectKeys,
} from '../src/utils/credential-inventory.js';
import { PROVIDER_ENV_MAP, STORAGE_PROVIDER_IDS } from '../src/utils/github-actions.js';
import { DEPLOYMENT_ENV_KEYS } from '../src/deployment/deployment-env.js';
import { generateWorkflowYaml } from '../src/utils/github-actions.js';
import yaml from 'js-yaml';

describe('exhaustive credential collision matrix (7×6)', () => {
  test('inventory covers every storage id and deployment method', () => {
    expect(STORAGE_PROVIDER_ORDER).toHaveLength(7);
    expect(DEPLOYMENT_METHOD_ORDER).toHaveLength(6);
    for (const id of STORAGE_PROVIDER_ORDER) {
      expect(STORAGE_RUNTIME_ENV_KEYS[id]).toBeDefined();
      expect(STORAGE_PROVIDER_IDS.has(id)).toBe(true);
    }
    for (const method of DEPLOYMENT_METHOD_ORDER) {
      expect(DEPLOYMENT_RUNTIME_ENV_KEYS[method]).toBeDefined();
      expect(DEPLOYMENT_ENV_KEYS[method]).toEqual(DEPLOYMENT_RUNTIME_ENV_KEYS[method]);
    }
  });

  test('Local storage has zero credential env vars', () => {
    expect(STORAGE_RUNTIME_ENV_KEYS.local).toEqual([]);
  });

  test('PROVIDER_ENV_MAP storage schema ⊆ runtime inventory (no undeclared schema-only secrets)', () => {
    for (const id of STORAGE_PROVIDER_ORDER) {
      const schema = PROVIDER_ENV_MAP[id] || [];
      const runtime = new Set([
        ...(STORAGE_RUNTIME_ENV_KEYS[id] || []),
        ...(STORAGE_RUNTIME_EXTRAS[id] || []),
      ]);
      const missingFromRuntime = schema.filter((k) => !runtime.has(k));
      expect(missingFromRuntime).toEqual([]);
    }
  });

  test('full 7×6 storage×deploy matrix: zero unintended overlaps', () => {
    const matrix = buildStorageDeployOverlapMatrix();
    // Explicitly touch every cell (42) so the assertion is exhaustive, not sparse.
    let cells = 0;
    for (const storageId of STORAGE_PROVIDER_ORDER) {
      for (const method of DEPLOYMENT_METHOD_ORDER) {
        cells += 1;
        expect(matrix[storageId][method]).toEqual([]);
      }
    }
    expect(cells).toBe(42);
    expect(listStorageDeployCollisions()).toEqual([]);
  });

  test('deploy×deploy shares are only SHARED BY DESIGN pairs', () => {
    const shares = listDeployDeployShares();
    const unexpected = shares.filter((s) => !s.designed);
    expect(unexpected).toEqual([]);

    // Every designed pair must still share exactly its declared keys (no silent drop).
    for (const pair of SHARED_BY_DESIGN_DEPLOY_PAIRS) {
      const [a, b] = pair.methods;
      const actual = intersectKeys(
        DEPLOYMENT_RUNTIME_ENV_KEYS[a],
        DEPLOYMENT_RUNTIME_ENV_KEYS[b]
      );
      expect(actual).toEqual([...pair.keys].sort());
    }
  });

  test('FTP runtime extras FTP_PORT/FTP_PATH do not collide with any deploy method', () => {
    for (const method of DEPLOYMENT_METHOD_ORDER) {
      expect(
        intersectKeys(['FTP_PORT', 'FTP_PATH'], DEPLOYMENT_RUNTIME_ENV_KEYS[method])
      ).toEqual([]);
    }
  });
});

describe('multi-method same-project: docker + kubernetes DOCKER_* prefixing', () => {
  test('development=docker + production=kubernetes keeps disjoint DOCKER_* secret bindings', () => {
    const environments = {
      development: {
        enabled: true,
        method: 'docker',
        trigger: 'push',
        config: { dockerImageName: 'org/dev' },
      },
      production: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'push',
        config: { kubeNamespace: 'prod', dockerImageName: 'org/prod' },
      },
    };
    const config = {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments,
    };
    const text = generateWorkflowYaml(
      ['local'],
      ['development', 'production'],
      environments,
      'npm:@akash-chowdhury-24/deployhub',
      config
    );
    const parsed = yaml.load(text);
    const step = (parsed?.jobs?.deploy?.steps || []).find(
      (/** @type {{ name?: string }} */ s) =>
        typeof s?.name === 'string' && s.name.includes('Build')
    );
    expect(step).toBeTruthy();
    const buildEnv = /** @type {Record<string, string>} */ (step.env || {});

    // Grandfathered docker (development)
    expect(buildEnv.DOCKER_IMAGE_NAME).toBe('${{ secrets.DOCKER_IMAGE_NAME }}');
    expect(buildEnv.DOCKER_REGISTRY_TOKEN).toBe('${{ secrets.DOCKER_REGISTRY_TOKEN }}');

    // Prefixed kubernetes (production) — same conceptual DOCKER_* names, distinct secrets
    expect(buildEnv.PRODUCTION_DOCKER_IMAGE_NAME).toBe(
      '${{ secrets.PRODUCTION_DOCKER_IMAGE_NAME }}'
    );
    expect(buildEnv.PRODUCTION_DOCKER_REGISTRY_TOKEN).toBe(
      '${{ secrets.PRODUCTION_DOCKER_REGISTRY_TOKEN }}'
    );
    expect(buildEnv.PRODUCTION_KUBE_CONTEXT).toBe(
      '${{ secrets.PRODUCTION_KUBE_CONTEXT }}'
    );

    // No last-wins clobber of grandfathered docker bindings
    expect(buildEnv.DOCKER_IMAGE_NAME).not.toBe(
      '${{ secrets.PRODUCTION_DOCKER_IMAGE_NAME }}'
    );
    expect(buildEnv.DOCKER_REGISTRY_TOKEN).not.toBe(
      '${{ secrets.PRODUCTION_DOCKER_REGISTRY_TOKEN }}'
    );
  });
});
