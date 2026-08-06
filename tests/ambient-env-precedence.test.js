import {
  applyEnvSecretOverlay,
  envUsesPrefixedSecrets,
} from '../src/deployment/deployment-env.js';
import {
  getEnvSettings,
  mergeMethodSettingsIntoEnv,
} from '../src/core/environments.js';

describe('local ambient env var precedence', () => {
  const config = {
    project: 'demo',
    projectType: 'backend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments: {
      development: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        // no host in config — grandfathered env reads ambient SSH_HOST
        config: { user: 'deploy', deployPath: '/var/www/dev' },
      },
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: {
          host: 'prod.config.example.com',
          user: 'deploy',
          deployPath: '/var/www/prod',
        },
      },
      staging: {
        enabled: true,
        method: 'docker',
        trigger: 'manual',
        config: { dockerImageName: 'org/staging-from-config' },
      },
    },
  };

  test('config dockerImageName wins over ambient DOCKER_IMAGE_NAME (mergeMethodSettingsIntoEnv)', () => {
    const ambient = { DOCKER_IMAGE_NAME: 'org/leftover-from-other-project' };
    const settings = getEnvSettings(config.environments.staging);
    const merged = mergeMethodSettingsIntoEnv(ambient, settings);
    expect(merged.DOCKER_IMAGE_NAME).toBe('org/staging-from-config');
  });

  test('grandfathered env still picks up ambient SSH_HOST when no config host', () => {
    expect(envUsesPrefixedSecrets('development', config)).toBe(false);
    const ambient = { SSH_HOST: 'dev-from-shell.example.com', SSH_USER: 'deploy' };
    const resolved = applyEnvSecretOverlay('development', config, ambient);
    expect(resolved.SSH_HOST).toBe('dev-from-shell.example.com');

    const settings = getEnvSettings(config.environments.development);
    const host = settings.host || resolved.SSH_HOST;
    expect(host).toBe('dev-from-shell.example.com');
  });

  test('non-grandfathered env: config host wins over ambient leftover SSH_HOST', () => {
    expect(envUsesPrefixedSecrets('production', config)).toBe(true);
    const ambient = { SSH_HOST: 'leftover-unrelated-project.example.com' };
    const resolved = applyEnvSecretOverlay('production', config, ambient);
    // Ambient unprefixed must not satisfy production
    expect(resolved.SSH_HOST).toBeUndefined();

    const settings = getEnvSettings(config.environments.production);
    const host = settings.host || resolved.SSH_HOST;
    expect(host).toBe('prod.config.example.com');
  });

  test('non-grandfathered env: ambient SSH_HOST alone does NOT satisfy missing config host', () => {
    const bareProd = {
      ...config,
      environments: {
        ...config.environments,
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: { user: 'deploy', deployPath: '/var/www/prod' },
        },
      },
    };
    const ambient = { SSH_HOST: 'leftover-unrelated-project.example.com' };
    const resolved = applyEnvSecretOverlay('production', bareProd, ambient);
    expect(resolved.SSH_HOST).toBeUndefined();

    const settings = getEnvSettings(bareProd.environments.production);
    const host = settings.host || resolved.SSH_HOST;
    expect(host).toBeFalsy();
  });

  test('non-grandfathered env: PRODUCTION_SSH_HOST remaps correctly', () => {
    const ambient = {
      SSH_HOST: 'leftover.example.com',
      PRODUCTION_SSH_HOST: 'real-prod.example.com',
    };
    const resolved = applyEnvSecretOverlay('production', config, ambient);
    expect(resolved.SSH_HOST).toBe('real-prod.example.com');
    expect(resolved.PRODUCTION_SSH_HOST).toBe('real-prod.example.com');
  });
});
