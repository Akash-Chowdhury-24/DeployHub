import yaml from 'js-yaml';
import {
  generateRollbackWorkflowYaml,
  extractWorkflowSecretKeys,
} from '../src/utils/github-actions.js';
import {
  applyEnvSecretOverlay,
  envUsesPrefixedSecrets,
} from '../src/deployment/deployment-env.js';
import { resolveDockerImageRef } from '../src/utils/docker-image.js';
import { mergeMethodSettingsIntoEnv, getEnvSettings } from '../src/core/environments.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

describe('CI secret overlay end-to-end (no cross-env leakage)', () => {
  const environments = {
    development: {
      enabled: true,
      method: 'ssh',
      trigger: 'push',
      config: { host: 'dev' },
    },
    staging: {
      enabled: true,
      method: 'docker',
      trigger: 'manual',
      config: { dockerImageName: 'should-not-override-secret' },
    },
    production: {
      enabled: true,
      method: 'kubernetes',
      trigger: 'manual',
      config: { kubeNamespace: 'prod', dockerImageName: 'also-ignored-here' },
    },
  };

  const config = {
    project: 'demo',
    projectType: 'frontend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments,
  };

  const deployEnvs = ['development', 'staging', 'production'];

  test('rollback YAML parses; overlay remaps each env without leaking across --env all', () => {
    const text = generateRollbackWorkflowYaml(
      ['local'],
      deployEnvs,
      environments,
      CLI,
      config
    );

    expect(() => yaml.load(text)).not.toThrow();
    const parsed = yaml.load(text);
    expect(parsed.jobs).toBeTruthy();

    // Prefixed envs only emit PREFIX_DOCKER_IMAGE_NAME — no unprefixed last-wins line
    // (grandfathered development is ssh here, so it never contributes DOCKER_IMAGE_NAME).
    const imageLines = text
      .split('\n')
      .filter((l) => /^\s+DOCKER_IMAGE_NAME:/.test(l));
    expect(imageLines).toHaveLength(0);

    expect(text).toContain('STAGING_DOCKER_IMAGE_NAME:');
    expect(text).toContain('PRODUCTION_DOCKER_IMAGE_NAME:');
    expect(extractWorkflowSecretKeys(text)).toEqual(
      expect.arrayContaining([
        'STAGING_DOCKER_IMAGE_NAME',
        'PRODUCTION_DOCKER_IMAGE_NAME',
      ])
    );

    expect(envUsesPrefixedSecrets('development', config)).toBe(false);
    expect(envUsesPrefixedSecrets('staging', config)).toBe(true);
    expect(envUsesPrefixedSecrets('production', config)).toBe(true);

    // Simulate CI env block after GHA injects per-env prefixed secrets plus
    // grandfathered unprefixed bindings (no last-wins overwrite of SSH_*/etc.).
    /** @type {Record<string, string>} */
    const ciEnv = {
      DOCKER_IMAGE_NAME: 'org/grandfathered-or-ambient',
      STAGING_DOCKER_IMAGE_NAME: 'org/staging-app',
      PRODUCTION_DOCKER_IMAGE_NAME: 'org/prod-app',
      SSH_HOST: 'dev.example.com',
      STAGING_DOCKER_REGISTRY_USERNAME: 'staging-user',
      PRODUCTION_DOCKER_REGISTRY_USERNAME: 'prod-user',
      DOCKER_REGISTRY_USERNAME: 'ambient-user',
    };

    // --- staging provider view (docker) ---
    const stagingEnv = applyEnvSecretOverlay('staging', config, ciEnv);
    expect(stagingEnv.DOCKER_IMAGE_NAME).toBe('org/staging-app');
    expect(stagingEnv.DOCKER_REGISTRY_USERNAME).toBe('staging-user');
    // Prefixed sibling must remain untouched for the other env
    expect(stagingEnv.PRODUCTION_DOCKER_IMAGE_NAME).toBe('org/prod-app');

    const stagingSettings = getEnvSettings(environments.staging);
    const stagingEffective = mergeMethodSettingsIntoEnv(stagingEnv, stagingSettings);
    // Config dockerImageName would normally win via merge — clear it to prove secret overlay path,
    // OR accept merge wins. Real providers use mergeMethodSettingsIntoEnv(env, settings) which
    // overlays settings.dockerImageName onto DOCKER_IMAGE_NAME when set.
    // For secret-only resolution (settings without image name), overlay must stick:
    const stagingSecretOnly = mergeMethodSettingsIntoEnv(stagingEnv, {});
    expect(resolveDockerImageRef(config, stagingSecretOnly).imageName).toBe('org/staging-app');
    expect(resolveDockerImageRef(config, stagingSecretOnly).fullImage).toMatch(
      /^org\/staging-app:/
    );

    // --- production provider view (kubernetes / same image ref helper) ---
    const productionEnv = applyEnvSecretOverlay('production', config, ciEnv);
    expect(productionEnv.DOCKER_IMAGE_NAME).toBe('org/prod-app');
    expect(productionEnv.DOCKER_REGISTRY_USERNAME).toBe('prod-user');
    expect(productionEnv.STAGING_DOCKER_IMAGE_NAME).toBe('org/staging-app');

    const productionSecretOnly = mergeMethodSettingsIntoEnv(productionEnv, {});
    expect(resolveDockerImageRef(config, productionSecretOnly).imageName).toBe('org/prod-app');
    expect(resolveDockerImageRef(config, productionSecretOnly).fullImage).toMatch(
      /^org\/prod-app:/
    );

    // Simultaneous --env all: each overlay is independent; staging result unchanged by production call
    expect(stagingEnv.DOCKER_IMAGE_NAME).toBe('org/staging-app');
    expect(productionEnv.DOCKER_IMAGE_NAME).toBe('org/prod-app');
    expect(stagingEnv.DOCKER_IMAGE_NAME).not.toBe(productionEnv.DOCKER_IMAGE_NAME);

    // Grandfathered development: no DEVELOPMENT_* remap; unprefixed SSH_HOST kept
    const devEnv = applyEnvSecretOverlay('development', config, ciEnv);
    expect(devEnv.SSH_HOST).toBe('dev.example.com');
    expect(devEnv.DOCKER_IMAGE_NAME).toBe('org/grandfathered-or-ambient');
  });
});
