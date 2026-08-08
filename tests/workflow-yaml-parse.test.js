import yaml from 'js-yaml';
import {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  extractWorkflowSecretKeys,
} from '../src/utils/github-actions.js';
import { getDeploymentWorkflowSecretKeysForEnv } from '../src/deployment/deployment-env.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

/**
 * @param {Record<string, any>} parsed
 * @param {string} stepNameSubstring
 * @returns {Record<string, string>}
 */
function stepEnv(parsed, stepNameSubstring) {
  const steps = parsed?.jobs?.deploy?.steps || parsed?.jobs?.rollback?.steps || [];
  const step = steps.find(
    (/** @type {{ name?: string }} */ s) =>
      typeof s?.name === 'string' && s.name.includes(stepNameSubstring)
  );
  expect(step).toBeTruthy();
  return /** @type {Record<string, string>} */ (step.env || {});
}

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

  test('deploy workflow is valid YAML with jobs, env dropdown, and step-scoped secret parity', () => {
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

    // Build and dispatch share the same enabled-env secret union (trigger does not
    // filter secrets — that split caused live Build-step PRODUCTION_* gaps).
    const buildEnv = stepEnv(parsed, 'Build');
    const dispatchEnv = stepEnv(parsed, 'workflow_dispatch');
    const allSecrets = expectedSecretKeysForEnvs(deployEnvs);
    for (const key of allSecrets) {
      expect(buildEnv[key]).toBe(`\${{ secrets.${key} }}`);
      expect(dispatchEnv[key]).toBe(`\${{ secrets.${key} }}`);
    }
    expect(buildEnv.STAGING_DOCKER_IMAGE_NAME).toBe(
      '${{ secrets.STAGING_DOCKER_IMAGE_NAME }}'
    );
    expect(buildEnv.PRODUCTION_KUBECONFIG).toBe('${{ secrets.PRODUCTION_KUBECONFIG }}');
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

    // Rollback maps secrets for every listed deploy env onto the Rollback step.
    const rollbackEnv = stepEnv(parsed, 'Rollback');
    const expected = expectedSecretKeysForEnvs(deployEnvs);
    for (const key of expected) {
      expect(rollbackEnv[key]).toBe(`\${{ secrets.${key} }}`);
    }

    // File-level extract still useful as a coarse check.
    const yamlSecrets = new Set(extractWorkflowSecretKeys(text));
    for (const key of expected) {
      expect(yamlSecrets.has(key)).toBe(true);
    }
  });
});

describe('2× EC2/SSH push envs — Build step carries both secret sets (regression)', () => {
  // Matches the real failing fixture: development + production EC2, both trigger:push.
  const environments = {
    development: {
      enabled: true,
      method: 'ec2',
      trigger: 'push',
      config: { host: 'dev.example.com' },
    },
    production: {
      enabled: true,
      method: 'ec2',
      trigger: 'push',
      config: { host: 'prod.example.com' },
    },
  };

  const config = {
    project: 'demo',
    projectType: 'frontend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments,
  };

  const coreKeys = ['SSH_HOST', 'SSH_USER', 'SSH_KEY', 'SSH_DEPLOY_PATH'];

  test('Build step env has grandfathered SSH_* and PRODUCTION_SSH_* simultaneously', () => {
    // Pass a stale deploy[] with only development — generation must still use
    // live environments (both push envs), matching pipelineDeployTargets.
    const text = generateWorkflowYaml(
      ['local'],
      ['development'],
      environments,
      CLI,
      config
    );

    const parsed = yaml.load(text);
    const buildEnv = stepEnv(parsed, 'Build');
    const dispatchEnv = stepEnv(parsed, 'workflow_dispatch');

    for (const key of coreKeys) {
      expect(buildEnv[key]).toBe(`\${{ secrets.${key} }}`);
      expect(buildEnv[`PRODUCTION_${key}`]).toBe(`\${{ secrets.PRODUCTION_${key} }}`);
      // Must not last-wins-overwrite grandfathered bindings with production secrets.
      expect(buildEnv[key]).not.toBe(`\${{ secrets.PRODUCTION_${key} }}`);
    }

    // Same shared helper; dispatch also needs both (and any future manual envs).
    for (const key of coreKeys) {
      expect(dispatchEnv[key]).toBe(`\${{ secrets.${key} }}`);
      expect(dispatchEnv[`PRODUCTION_${key}`]).toBe(
        `\${{ secrets.PRODUCTION_${key} }}`
      );
    }
  });

  test('sync-style regenerate with full deploy list still keeps both sets on Build', () => {
    const text = generateWorkflowYaml(
      ['local'],
      ['development', 'production'],
      environments,
      CLI,
      config
    );
    const parsed = yaml.load(text);
    const buildEnv = stepEnv(parsed, 'Build');
    expect(buildEnv.SSH_KEY).toBe('${{ secrets.SSH_KEY }}');
    expect(buildEnv.PRODUCTION_SSH_KEY).toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
  });

  test('REGRESSION: Build must match Dispatch for PRODUCTION_* even if production were manual', () => {
    // The live bug: Dispatch had PRODUCTION_*; Build did not. Prior tests only used
    // both-push fixtures, so a push-only Build filter still passed. This fixture
    // uses production=manual — the OLD push-filtered Build would omit PRODUCTION_*
    // while Dispatch included it. That asymmetry must never pass again.
    const mixed = {
      development: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: { host: 'dev.example.com' },
      },
      production: {
        enabled: true,
        method: 'ec2',
        trigger: 'manual',
        config: { host: 'prod.example.com' },
      },
    };
    const cfg = {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments: mixed,
    };
    const text = generateWorkflowYaml(['aws'], ['development'], mixed, CLI, cfg);
    const parsed = yaml.load(text);
    const buildEnv = stepEnv(parsed, 'Build');
    const dispatchEnv = stepEnv(parsed, 'workflow_dispatch');

    expect(buildEnv.PRODUCTION_SSH_KEY).toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
    expect(dispatchEnv.PRODUCTION_SSH_KEY).toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
    expect(buildEnv.PRODUCTION_SSH_KEY).toBe(dispatchEnv.PRODUCTION_SSH_KEY);
    expect(buildEnv.SSH_KEY).toBe('${{ secrets.SSH_KEY }}');
  });
});

describe('workflow_dispatch dropdown omits disabled environments', () => {
  test('disabled env name is not in deploy or rollback choice options', () => {
    const environments = {
      development: {
        enabled: true,
        method: 'ssh',
        trigger: 'push',
        config: { host: 'dev' },
      },
      staging: {
        enabled: false,
        method: 'docker',
        trigger: 'manual',
        config: { dockerImageName: 'org/staging' },
      },
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { host: 'prod' },
      },
    };
    const config = {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments,
    };

    const deployParsed = yaml.load(
      generateWorkflowYaml(['local'], ['development', 'production'], environments, CLI, config)
    );
    const rollbackParsed = yaml.load(
      generateRollbackWorkflowYaml(
        ['local'],
        ['development', 'production'],
        environments,
        CLI,
        config
      )
    );

    const deployOpts = deployParsed.on.workflow_dispatch.inputs.environment.options;
    const rollbackOpts =
      rollbackParsed.on.workflow_dispatch.inputs.environment.options;

    expect(deployOpts).toEqual(['development', 'production', 'all']);
    expect(deployOpts).not.toContain('staging');
    expect(rollbackOpts).toEqual(['development', 'production', 'all']);
    expect(rollbackOpts).not.toContain('staging');
  });
});
