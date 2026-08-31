import yaml from 'js-yaml';
import {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  getBranchMappingDoctorCheck,
  formatPushTriggerYaml,
} from '../src/utils/github-actions.js';
import {
  getWorkflowPushBranches,
  formatBranchMappingSummary,
  configHasBranchMapping,
  normalizeGitBranchName,
} from '../src/core/environments.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

function mappedConfig() {
  const environments = {
    production: {
      enabled: true,
      method: 'ec2',
      trigger: 'push',
      branch: 'main',
      config: { host: 'prod.example.com' },
    },
    staging: {
      enabled: true,
      method: 'ec2',
      trigger: 'push',
      branch: 'dev',
      config: { host: 'stg.example.com' },
    },
  };
  return {
    project: 'demo',
    projectType: 'frontend',
    defaultEnvironment: 'production',
    unprefixedSecretEnvironment: 'production',
    storage: ['local'],
    environments,
  };
}

describe('per-environment branch mapping (workflow YAML + helpers)', () => {
  test('normalizeGitBranchName strips refs/heads/ and rejects blanks', () => {
    expect(normalizeGitBranchName('refs/heads/dev')).toEqual({ ok: true, name: 'dev' });
    expect(normalizeGitBranchName('  main  ')).toEqual({ ok: true, name: 'main' });
    expect(normalizeGitBranchName('')).toMatchObject({ ok: false });
    expect(normalizeGitBranchName('feat two')).toMatchObject({ ok: false });
  });

  test('no branch field on any env → grandfathered [main]', () => {
    const config = {
      environments: {
        production: { enabled: true, method: 'ssh', trigger: 'push', config: {} },
        staging: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };
    expect(configHasBranchMapping(config)).toBe(false);
    expect(getWorkflowPushBranches(config)).toEqual(['main']);
  });

  test('main → production, dev → staging → trigger list is exactly [main, dev]', () => {
    const config = mappedConfig();
    expect(configHasBranchMapping(config)).toBe(true);
    expect(getWorkflowPushBranches(config)).toEqual(['main', 'dev']);
  });

  test('generated workflow on.push.branches is exactly [main, dev]; akash is absent', () => {
    const config = mappedConfig();
    const text = generateWorkflowYaml(
      ['local'],
      ['production', 'staging'],
      config.environments,
      CLI,
      config
    );
    const parsed = yaml.load(text);
    expect(parsed.on.push.branches).toEqual(['main', 'dev']);
    expect(parsed.on.push.branches).not.toContain('akash');
    expect(parsed.on.push.branches).not.toContain('bumba');
    expect(text).toContain('branches: [main, dev]');
    expect(text).not.toMatch(/branches:.*akash/);
    // workflow_dispatch environment picker is unchanged
    expect(parsed.on.workflow_dispatch.inputs.environment.options).toEqual([
      'production',
      'staging',
      'all',
    ]);
  });

  test('rollback workflow stays workflow_dispatch-only (no push trigger)', () => {
    const config = mappedConfig();
    const text = generateRollbackWorkflowYaml(
      ['local'],
      ['production', 'staging'],
      config.environments,
      CLI,
      config
    );
    const parsed = yaml.load(text);
    expect(parsed.on.push).toBeUndefined();
    expect(parsed.on.workflow_dispatch).toBeTruthy();
    expect(parsed.on.workflow_dispatch.inputs.environment.options).toEqual([
      'production',
      'staging',
      'all',
    ]);
  });

  test('init/doctor summary names mapped branches and the exclusion', () => {
    const summary = formatBranchMappingSummary(getWorkflowPushBranches(mappedConfig()));
    expect(summary).toBe(
      [
        'Branches mapped to an environment: main, dev',
        'Pushes to any other branch will not trigger DeployHub.',
      ].join('\n')
    );
    const doctor = getBranchMappingDoctorCheck(mappedConfig());
    expect(doctor.pass).toBe(true);
    expect(doctor.message).toMatch(/Branches mapped to an environment: main, dev/);
    expect(doctor.message).toMatch(/Pushes to any other branch will not trigger DeployHub/);
  });

  test('formatPushTriggerYaml omits push when the mapped list is empty', () => {
    expect(formatPushTriggerYaml([])).toBe('');
    expect(formatPushTriggerYaml(['main', 'dev'])).toBe(
      '  push:\n    branches: [main, dev]\n'
    );
  });

  test('grandfathered config still generates branches: [main]', () => {
    const environments = {
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'push',
        config: { host: 'p' },
      },
    };
    const config = {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'production',
      environments,
    };
    const text = generateWorkflowYaml(['local'], ['production'], environments, CLI, config);
    const parsed = yaml.load(text);
    expect(parsed.on.push.branches).toEqual(['main']);
  });
});
