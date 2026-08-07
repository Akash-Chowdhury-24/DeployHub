import yaml from 'js-yaml';
import { generateWorkflowYaml } from '../src/utils/github-actions.js';
import { getDeploymentWorkflowSecretKeysForEnv } from '../src/deployment/deployment-env.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

/**
 * @param {Record<string, any>} parsed
 * @param {string} stepNameSubstring
 * @returns {Record<string, string>}
 */
function stepEnv(parsed, stepNameSubstring) {
  const step = (parsed?.jobs?.deploy?.steps || []).find(
    (/** @type {{ name?: string }} */ s) =>
      typeof s?.name === 'string' && s.name.includes(stepNameSubstring)
  );
  expect(step).toBeTruthy();
  return /** @type {Record<string, string>} */ (step.env || {});
}

/**
 * Assert Build env has every secret key for each env, with correct prefixing,
 * and grandfathered unprefixed values are not clobbered by PRODUCTION_* secrets.
 *
 * @param {Record<string, { enabled?: boolean, method: string, trigger?: string, config?: object }>} environments
 * @param {string} grandfathered
 * @param {string[]} [staleDeploy]
 */
function assertBuildHasAllPushSecretSets(environments, grandfathered, staleDeploy) {
  const config = {
    project: 'demo',
    projectType: 'frontend',
    defaultEnvironment: grandfathered,
    unprefixedSecretEnvironment: grandfathered,
    environments,
  };
  const names = Object.keys(environments);
  const text = generateWorkflowYaml(
    ['local'],
    staleDeploy || [grandfathered],
    environments,
    CLI,
    config
  );
  const buildEnv = stepEnv(yaml.load(text), 'Build');

  /** @type {string[]} */
  const expected = [];
  for (const name of names) {
    const method = environments[name].method;
    for (const key of getDeploymentWorkflowSecretKeysForEnv(
      name,
      method,
      config,
      environments
    )) {
      expected.push(key);
      // KUBECONFIG is special-cased for CI to the workspace kubeconfig path.
      if (key === 'KUBECONFIG') {
        expect(buildEnv.KUBECONFIG).toBe('${{ github.workspace }}/.kube/config');
        continue;
      }
      expect(buildEnv[key]).toBe(`\${{ secrets.${key} }}`);
    }
  }

  // No grandfathered unprefixed key may point at another env's prefixed secret.
  for (const key of getDeploymentWorkflowSecretKeysForEnv(
    grandfathered,
    environments[grandfathered].method,
    config,
    environments
  )) {
    if (key === 'KUBECONFIG') continue;
    expect(buildEnv[key]).toBe(`\${{ secrets.${key} }}`);
    expect(buildEnv[key]).not.toMatch(/secrets\.(STAGING_|PRODUCTION_)/);
  }

  return { buildEnv, expected };
}

describe('multi-method Build env secret union (same bugs as 2×EC2)', () => {
  test('Docker: 2× push — grandfathered + PRODUCTION_* both present, no clobber', () => {
    const environments = {
      staging: {
        enabled: true,
        method: 'docker',
        trigger: 'push',
        config: { dockerImageName: 'org/staging' },
      },
      production: {
        enabled: true,
        method: 'docker',
        trigger: 'push',
        config: { dockerImageName: 'org/prod' },
      },
    };

    const { buildEnv } = assertBuildHasAllPushSecretSets(environments, 'staging');

    expect(buildEnv.DOCKER_IMAGE_NAME).toBe('${{ secrets.DOCKER_IMAGE_NAME }}');
    expect(buildEnv.DOCKER_REGISTRY_USERNAME).toBe(
      '${{ secrets.DOCKER_REGISTRY_USERNAME }}'
    );
    expect(buildEnv.DOCKER_REGISTRY_TOKEN).toBe('${{ secrets.DOCKER_REGISTRY_TOKEN }}');
    expect(buildEnv.PRODUCTION_DOCKER_IMAGE_NAME).toBe(
      '${{ secrets.PRODUCTION_DOCKER_IMAGE_NAME }}'
    );
    expect(buildEnv.PRODUCTION_DOCKER_REGISTRY_USERNAME).toBe(
      '${{ secrets.PRODUCTION_DOCKER_REGISTRY_USERNAME }}'
    );
    expect(buildEnv.PRODUCTION_DOCKER_REGISTRY_TOKEN).toBe(
      '${{ secrets.PRODUCTION_DOCKER_REGISTRY_TOKEN }}'
    );
    // Must not last-wins-map unprefixed onto production secrets.
    expect(buildEnv.DOCKER_IMAGE_NAME).not.toBe(
      '${{ secrets.PRODUCTION_DOCKER_IMAGE_NAME }}'
    );
  });

  test('Kubernetes: 2× push — both secret sets + CI KUBECONFIG path, no clobber', () => {
    const environments = {
      staging: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'push',
        config: { kubeNamespace: 'staging' },
      },
      production: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'push',
        config: { kubeNamespace: 'prod' },
      },
    };

    const { buildEnv } = assertBuildHasAllPushSecretSets(environments, 'staging');

    expect(buildEnv.KUBE_CONTEXT).toBe('${{ secrets.KUBE_CONTEXT }}');
    expect(buildEnv.DOCKER_IMAGE_NAME).toBe('${{ secrets.DOCKER_IMAGE_NAME }}');
    expect(buildEnv.DOCKER_REGISTRY_USERNAME).toBe(
      '${{ secrets.DOCKER_REGISTRY_USERNAME }}'
    );
    expect(buildEnv.PRODUCTION_KUBE_CONTEXT).toBe(
      '${{ secrets.PRODUCTION_KUBE_CONTEXT }}'
    );
    expect(buildEnv.PRODUCTION_DOCKER_IMAGE_NAME).toBe(
      '${{ secrets.PRODUCTION_DOCKER_IMAGE_NAME }}'
    );
    expect(buildEnv.PRODUCTION_KUBECONFIG).toBe('${{ secrets.PRODUCTION_KUBECONFIG }}');
    // CI forces unprefixed KUBECONFIG to the workspace file written by setup steps.
    expect(buildEnv.KUBECONFIG).toBe('${{ github.workspace }}/.kube/config');
    expect(buildEnv.KUBE_CONTEXT).not.toBe('${{ secrets.PRODUCTION_KUBE_CONTEXT }}');
  });

  test('Azure VM: 2× push — SSH + Azure lookup secrets for both envs', () => {
    const environments = {
      staging: {
        enabled: true,
        method: 'azure-vm',
        trigger: 'push',
        config: { host: 'staging.example.com' },
      },
      production: {
        enabled: true,
        method: 'azure-vm',
        trigger: 'push',
        config: { host: 'prod.example.com' },
      },
    };

    const { buildEnv } = assertBuildHasAllPushSecretSets(environments, 'staging');

    expect(buildEnv.SSH_HOST).toBe('${{ secrets.SSH_HOST }}');
    expect(buildEnv.SSH_KEY).toBe('${{ secrets.SSH_KEY }}');
    expect(buildEnv.AZURE_VM_NAME).toBe('${{ secrets.AZURE_VM_NAME }}');
    expect(buildEnv.AZURE_CLIENT_SECRET).toBe('${{ secrets.AZURE_CLIENT_SECRET }}');
    expect(buildEnv.PRODUCTION_SSH_HOST).toBe('${{ secrets.PRODUCTION_SSH_HOST }}');
    expect(buildEnv.PRODUCTION_SSH_KEY).toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
    expect(buildEnv.PRODUCTION_AZURE_VM_NAME).toBe(
      '${{ secrets.PRODUCTION_AZURE_VM_NAME }}'
    );
    expect(buildEnv.PRODUCTION_AZURE_CLIENT_SECRET).toBe(
      '${{ secrets.PRODUCTION_AZURE_CLIENT_SECRET }}'
    );
    expect(buildEnv.SSH_KEY).not.toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
  });

  test('GCP VM: 2× push — SSH + GCP lookup secrets for both envs', () => {
    const environments = {
      staging: {
        enabled: true,
        method: 'gcp-vm',
        trigger: 'push',
        config: { host: 'staging.example.com' },
      },
      production: {
        enabled: true,
        method: 'gcp-vm',
        trigger: 'push',
        config: { host: 'prod.example.com' },
      },
    };

    const { buildEnv } = assertBuildHasAllPushSecretSets(environments, 'staging');

    expect(buildEnv.SSH_HOST).toBe('${{ secrets.SSH_HOST }}');
    expect(buildEnv.SSH_KEY).toBe('${{ secrets.SSH_KEY }}');
    expect(buildEnv.GCP_INSTANCE_NAME).toBe('${{ secrets.GCP_INSTANCE_NAME }}');
    expect(buildEnv.PRODUCTION_SSH_HOST).toBe('${{ secrets.PRODUCTION_SSH_HOST }}');
    expect(buildEnv.PRODUCTION_SSH_KEY).toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
    expect(buildEnv.PRODUCTION_GCP_INSTANCE_NAME).toBe(
      '${{ secrets.PRODUCTION_GCP_INSTANCE_NAME }}'
    );
    expect(buildEnv.SSH_KEY).not.toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
  });

  test('Mixed ec2+docker+kubernetes ALL push — complete disjoint secret sets, no cross-contamination', () => {
    const environments = {
      development: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: { host: 'dev.example.com' },
      },
      staging: {
        enabled: true,
        method: 'docker',
        trigger: 'push',
        config: { dockerImageName: 'org/staging' },
      },
      production: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'push',
        config: { kubeNamespace: 'prod' },
      },
    };

    const { buildEnv, expected } = assertBuildHasAllPushSecretSets(
      environments,
      'development',
      ['development'] // stale deploy[] — must still include staging+production
    );

    // EC2 grandfathered
    expect(buildEnv.SSH_HOST).toBe('${{ secrets.SSH_HOST }}');
    expect(buildEnv.SSH_KEY).toBe('${{ secrets.SSH_KEY }}');
    expect(buildEnv.EC2_INSTANCE_ID).toBe('${{ secrets.EC2_INSTANCE_ID }}');

    // Docker staging (prefixed) — must not appear as unprefixed DOCKER_* from last-wins
    expect(buildEnv.STAGING_DOCKER_IMAGE_NAME).toBe(
      '${{ secrets.STAGING_DOCKER_IMAGE_NAME }}'
    );
    expect(buildEnv.STAGING_DOCKER_REGISTRY_TOKEN).toBe(
      '${{ secrets.STAGING_DOCKER_REGISTRY_TOKEN }}'
    );
    expect(buildEnv.DOCKER_IMAGE_NAME).toBeUndefined();

    // Kubernetes production
    expect(buildEnv.PRODUCTION_KUBE_CONTEXT).toBe(
      '${{ secrets.PRODUCTION_KUBE_CONTEXT }}'
    );
    expect(buildEnv.PRODUCTION_DOCKER_IMAGE_NAME).toBe(
      '${{ secrets.PRODUCTION_DOCKER_IMAGE_NAME }}'
    );
    expect(buildEnv.PRODUCTION_DOCKER_REGISTRY_USERNAME).toBe(
      '${{ secrets.PRODUCTION_DOCKER_REGISTRY_USERNAME }}'
    );
    expect(buildEnv.PRODUCTION_KUBECONFIG).toBe('${{ secrets.PRODUCTION_KUBECONFIG }}');
    expect(buildEnv.KUBECONFIG).toBe('${{ github.workspace }}/.kube/config');

    // Cross-contamination: SSH must not be remapped; staging/prod prefixes stay distinct
    expect(buildEnv.SSH_KEY).not.toMatch(/STAGING_|PRODUCTION_/);
    expect(buildEnv.STAGING_DOCKER_IMAGE_NAME).not.toBe(
      buildEnv.PRODUCTION_DOCKER_IMAGE_NAME
    );
    expect(expected.length).toBeGreaterThan(20);
  });
});
