import {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  extractWorkflowSecretKeys,
  getCliDeployCommand,
} from '../src/utils/github-actions.js';
import {
  shouldPrefixEnvSecrets,
  prefixSecretKey,
  getDeploymentWorkflowSecretKeysForEnv,
} from '../src/deployment/deployment-env.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

describe('multi-env workflow generation', () => {
  const environments = {
    development: {
      enabled: true,
      method: 'ssh',
      trigger: 'push',
      config: { host: 'dev' },
    },
    production: {
      enabled: true,
      method: 'kubernetes',
      trigger: 'manual',
      config: { kubeNamespace: 'prod' },
    },
  };

  test('shouldPrefixEnvSecrets only when 2+ envs', () => {
    expect(shouldPrefixEnvSecrets({ production: {} })).toBe(false);
    expect(shouldPrefixEnvSecrets(environments)).toBe(true);
    expect(prefixSecretKey('production', 'SSH_HOST')).toBe('PRODUCTION_SSH_HOST');
  });

  test('deploy workflow has environment choice and maps prefixed secrets', () => {
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

    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).toContain('environment:');
    expect(yaml).toContain('type: choice');
    expect(yaml).toContain('- development');
    expect(yaml).toContain('- production');
    expect(yaml).toContain('- all');
    expect(yaml).toContain(getCliDeployCommand());
    // Grandfathered development keeps secrets.SSH_HOST (not DEVELOPMENT_SSH_HOST)
    expect(yaml).toContain('SSH_HOST: ${{ secrets.SSH_HOST }}');
    expect(yaml).not.toContain('secrets.DEVELOPMENT_SSH_HOST');
  });

  test('rollback workflow secret parity with deploy across N envs', () => {
    const storage = ['aws'];
    const deployEnvs = ['development', 'production'];
    const config = {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments,
    };

    const deployYaml = generateWorkflowYaml(storage, deployEnvs, environments, CLI, config);
    const rollbackYaml = generateRollbackWorkflowYaml(
      storage,
      deployEnvs,
      environments,
      CLI,
      config
    );

    const deploySecrets = new Set(extractWorkflowSecretKeys(deployYaml));
    const rollbackSecrets = new Set(extractWorkflowSecretKeys(rollbackYaml));

    // Every secret referenced by deploy for these envs must appear in rollback (parity).
    // Rollback may include production secrets that deploy's push-path build job omitted.
    for (const key of deploySecrets) {
      expect(rollbackSecrets.has(key)).toBe(true);
    }

    expect(rollbackYaml).toContain('environment:');
    expect(rollbackYaml).toContain('--env');
  });

  test('getDeploymentWorkflowSecretKeysForEnv prefixes only non-grandfathered env', () => {
    const config = {
      projectType: 'frontend',
      unprefixedSecretEnvironment: 'development',
      environments,
    };
    const prodKeys = getDeploymentWorkflowSecretKeysForEnv(
      'production',
      'ssh',
      config,
      environments
    );
    const devKeys = getDeploymentWorkflowSecretKeysForEnv(
      'development',
      'ssh',
      config,
      environments
    );
    expect(prodKeys).toContain('PRODUCTION_SSH_HOST');
    expect(prodKeys).not.toContain('SSH_HOST');
    expect(devKeys).toContain('SSH_HOST');
    expect(devKeys).not.toContain('DEVELOPMENT_SSH_HOST');
  });
});
