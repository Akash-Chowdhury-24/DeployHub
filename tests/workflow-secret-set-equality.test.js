import yaml from 'js-yaml';
import {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
} from '../src/utils/github-actions.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

function stepEnv(parsed, namePart) {
  const steps = parsed.jobs.deploy?.steps || parsed.jobs.rollback?.steps || [];
  return steps.find((s) => String(s.name || '').includes(namePart))?.env || {};
}

function secretKeys(env) {
  return Object.keys(env)
    .filter((k) => k !== 'DEPLOYHUB_ENV')
    .sort();
}

describe('Build / Dispatch / Rollback secret-set equality (anti-asymmetry)', () => {
  test('mixed trigger 2×EC2: Build, Dispatch, Rollback share identical secret keys+refs', () => {
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
        trigger: 'manual',
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

    const deployYaml = generateWorkflowYaml(
      ['aws'],
      ['development', 'production'],
      environments,
      CLI,
      config
    );
    const rollbackYaml = generateRollbackWorkflowYaml(
      ['aws'],
      ['development', 'production'],
      environments,
      CLI,
      config
    );
    const deploy = yaml.load(deployYaml);
    const rollback = yaml.load(rollbackYaml);
    const build = stepEnv(deploy, 'Build');
    const dispatch = stepEnv(deploy, 'workflow_dispatch');
    const rb = stepEnv(rollback, 'Rollback');

    expect(secretKeys(build)).toEqual(secretKeys(dispatch));
    expect(secretKeys(build)).toEqual(secretKeys(rb));
    for (const k of secretKeys(build)) {
      expect(build[k]).toBe(dispatch[k]);
      expect(build[k]).toBe(rb[k]);
    }
    // Manual env secrets still present on Build
    expect(build.PRODUCTION_SSH_KEY).toBe('${{ secrets.PRODUCTION_SSH_KEY }}');
  });

  test('non-grandfathered k8s: Configure kubeconfig reads PRODUCTION_KUBECONFIG', () => {
    const environments = {
      development: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: { host: 'dev.example.com' },
      },
      production: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'push',
        config: { kubeNamespace: 'prod' },
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
      ['aws'],
      ['development', 'production'],
      environments,
      CLI,
      config
    );
    expect(text).toContain(
      'KUBECONFIG_SECRET: ${{ secrets.PRODUCTION_KUBECONFIG }}'
    );
    expect(text).not.toMatch(
      /Configure kubeconfig[\s\S]*KUBECONFIG_SECRET: \$\{\{ secrets\.KUBECONFIG \}\}/
    );

    const rb = generateRollbackWorkflowYaml(
      ['aws'],
      ['development', 'production'],
      environments,
      CLI,
      config
    );
    expect(rb).toContain(
      'KUBECONFIG_SECRET: ${{ secrets.PRODUCTION_KUBECONFIG }}'
    );
  });
});
