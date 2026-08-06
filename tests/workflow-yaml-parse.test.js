import yaml from 'js-yaml';
import {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  extractWorkflowSecretKeys,
} from '../src/utils/github-actions.js';
import { getDeploymentWorkflowSecretKeysForEnv } from '../src/deployment/deployment-env.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

describe('generated workflow YAML parses with js-yaml', () => {
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
      config: { dockerImageName: 'org/app' },
    },
    production: {
      enabled: true,
      method: 'kubernetes',
      trigger: 'manual',
      config: { kubeNamespace: 'prod' },
    },
  };

  const deployEnvs = ['development', 'staging', 'production'];
  const config = {
    project: 'demo',
    projectType: 'frontend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments,
  };

  /** @param {string[]} names */
  function expectedSecretKeysForEnvs(names) {
    /** @type {Set<string>} */
    const keys = new Set();
    for (const name of names) {
      const method = environments[name].method;
      for (const k of getDeploymentWorkflowSecretKeysForEnv(
        name,
        method,
        config,
        environments
      )) {
        keys.add(k);
      }
    }
    return keys;
  }

  test('deploy workflow is valid YAML with jobs, env dropdown, and secret parity', () => {
    const text = generateWorkflowYaml(['local'], deployEnvs, environments, CLI, config);

    let parsed;
    expect(() => {
      parsed = yaml.load(text);
    }).not.toThrow();

    expect(parsed).toBeTruthy();
    expect(parsed.jobs).toBeTruthy();
    expect(Object.keys(parsed.jobs).length).toBeGreaterThan(0);

    const options = parsed.on?.workflow_dispatch?.inputs?.environment?.options;
    expect(options).toEqual(
      expect.arrayContaining(['development', 'staging', 'production', 'all'])
    );
    expect(options).toHaveLength(4);

    // Deploy build job maps secrets for push-triggered envs only (development here).
    const yamlSecrets = new Set(extractWorkflowSecretKeys(text));
    const pushSecrets = expectedSecretKeysForEnvs(['development']);
    for (const key of pushSecrets) {
      expect(yamlSecrets.has(key)).toBe(true);
    }
  });

  test('rollback workflow is valid YAML with jobs, env dropdown, and secret parity', () => {
    const text = generateRollbackWorkflowYaml(
      ['local'],
      deployEnvs,
      environments,
      CLI,
      config
    );

    let parsed;
    expect(() => {
      parsed = yaml.load(text);
    }).not.toThrow();

    expect(parsed).toBeTruthy();
    expect(parsed.jobs).toBeTruthy();

    const options = parsed.on?.workflow_dispatch?.inputs?.environment?.options;
    expect(options).toEqual(
      expect.arrayContaining(['development', 'staging', 'production', 'all'])
    );
    expect(options).toHaveLength(4);

    // Rollback maps secrets for every listed deploy env.
    const yamlSecrets = new Set(extractWorkflowSecretKeys(text));
    const expected = expectedSecretKeysForEnvs(deployEnvs);
    for (const key of expected) {
      expect(yamlSecrets.has(key)).toBe(true);
    }
  });
});
