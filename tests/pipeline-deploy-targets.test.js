import { generateWorkflowYaml } from '../src/utils/github-actions.js';
import { pipelineDeployTargets } from '../src/core/stages.js';
import yaml from 'js-yaml';

describe('trigger still gates deploy targets (separate from secret injection)', () => {
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
    pipeline: { deploy: true },
  };

  test('GHA push: only trigger=push envs are deploy targets; manual is skipped', () => {
    const targets = pipelineDeployTargets(config, {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
    });

    expect(targets).toEqual(['development']);
    expect(targets).not.toContain('production');
  });

  test('GHA workflow_dispatch: build deploy stage targets none (dispatch step handles --env)', () => {
    const targets = pipelineDeployTargets(config, {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(targets).toEqual([]);
  });

  test('post-secret-union-fix: Build job may inject PRODUCTION_* secrets without deploying production on push', () => {
    // Secrets union (all enabled) must NOT imply deploy targeting.
    const text = generateWorkflowYaml(
      ['aws'],
      ['development', 'production'],
      environments,
      'npm:@akash-chowdhury-24/deployhub',
      config
    );
    const parsed = yaml.load(text);
    const buildEnv = parsed.jobs.deploy.steps.find((s) =>
      String(s.name || '').includes('Build')
    ).env;

    // Secrets available for manual env (defensive injection)
    expect(buildEnv.PRODUCTION_SSH_KEY).toBe('${{ secrets.PRODUCTION_SSH_KEY }}');

    // But push-triggered build still must not target production
    const targets = pipelineDeployTargets(config, {
      GITHUB_ACTIONS: '1',
      GITHUB_EVENT_NAME: 'push',
    });
    expect(targets).toEqual(['development']);
    expect(targets).not.toContain('production');
  });
});
