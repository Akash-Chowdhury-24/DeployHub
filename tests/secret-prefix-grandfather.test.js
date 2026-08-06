import {
  envUsesPrefixedSecrets,
  resolveUnprefixedSecretEnvironment,
  getDeploymentWorkflowSecretKeysForEnv,
  shouldPrefixEnvSecrets,
  prefixSecretKey,
} from '../src/deployment/deployment-env.js';
import { generateWorkflowYaml, extractWorkflowSecretKeys } from '../src/utils/github-actions.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

describe('secret-prefix grandfathering (1→2 environments)', () => {
  test('single env uses unprefixed secrets', () => {
    const config = {
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments: {
        development: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };
    expect(shouldPrefixEnvSecrets(config.environments)).toBe(false);
    expect(envUsesPrefixedSecrets('development', config)).toBe(false);
    expect(
      getDeploymentWorkflowSecretKeysForEnv('development', 'ssh', config, config.environments)
    ).toContain('SSH_HOST');
    expect(
      getDeploymentWorkflowSecretKeysForEnv('development', 'ssh', config, config.environments)
    ).not.toContain('DEVELOPMENT_SSH_HOST');
  });

  test('after adding second env, original stays unprefixed; new env is prefixed', () => {
    const config = {
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments: {
        development: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
        production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };

    expect(resolveUnprefixedSecretEnvironment(config)).toBe('development');
    expect(envUsesPrefixedSecrets('development', config)).toBe(false);
    expect(envUsesPrefixedSecrets('production', config)).toBe(true);

    const devKeys = getDeploymentWorkflowSecretKeysForEnv(
      'development',
      'ssh',
      config,
      config.environments
    );
    const prodKeys = getDeploymentWorkflowSecretKeysForEnv(
      'production',
      'ssh',
      config,
      config.environments
    );

    expect(devKeys).toContain('SSH_HOST');
    expect(devKeys).not.toContain('DEVELOPMENT_SSH_HOST');
    expect(prodKeys).toContain('PRODUCTION_SSH_HOST');
    expect(prodKeys).not.toContain('SSH_HOST');
    expect(prefixSecretKey('production', 'SSH_HOST')).toBe('PRODUCTION_SSH_HOST');
  });

  test('workflow maps grandfathered env to unprefixed secret name', () => {
    const environments = {
      development: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      production: { enabled: true, method: 'kubernetes', trigger: 'manual', config: {} },
    };
    const config = {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments,
    };

    const yaml = generateWorkflowYaml(
      ['aws'],
      ['development', 'production'],
      environments,
      CLI,
      config
    );
    const secrets = extractWorkflowSecretKeys(yaml);

    // Grandfathered development → secrets.SSH_HOST (not DEVELOPMENT_SSH_HOST)
    expect(yaml).toMatch(/SSH_HOST:\s*\$\{\{\s*secrets\.SSH_HOST\s*\}\}/);
    expect(secrets).toContain('SSH_HOST');
    expect(secrets).not.toContain('DEVELOPMENT_SSH_HOST');
  });

  test('unprefixedSecretEnvironment does not silently follow a changed defaultEnvironment', () => {
    const config = {
      defaultEnvironment: 'production', // user changed default later
      unprefixedSecretEnvironment: 'development', // permanently grandfathered
      environments: {
        development: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
        production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };
    expect(resolveUnprefixedSecretEnvironment(config)).toBe('development');
    expect(envUsesPrefixedSecrets('development', config)).toBe(false);
    expect(envUsesPrefixedSecrets('production', config)).toBe(true);
  });
});
