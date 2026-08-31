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

describe('per-environment branch mapping gates push deploy targets', () => {
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

  const config = {
    project: 'demo',
    projectType: 'frontend',
    defaultEnvironment: 'production',
    unprefixedSecretEnvironment: 'production',
    environments,
    pipeline: { deploy: true },
  };

  test('GHA push on dev resolves only staging', () => {
    expect(
      pipelineDeployTargets(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/dev',
      })
    ).toEqual(['staging']);
  });

  test('GHA push on main resolves only production', () => {
    expect(
      pipelineDeployTargets(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
      })
    ).toEqual(['production']);
  });

  test('GHA push on unmapped branch resolves no environments', () => {
    expect(
      pipelineDeployTargets(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/akash',
      })
    ).toEqual([]);
  });

  test('two envs mapped to the same branch both deploy', () => {
    const shared = {
      ...config,
      environments: {
        production: { ...environments.production, branch: 'main' },
        staging: { ...environments.staging, branch: 'main' },
      },
    };
    expect(
      pipelineDeployTargets(shared, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
      })
    ).toEqual(['production', 'staging']);
  });

  test('workflow_dispatch still targets none (explicit --env step handles it)', () => {
    expect(
      pipelineDeployTargets(config, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/dev',
      })
    ).toEqual([]);
  });

  test('configs with no branch field keep grandfathered all-push-envs behavior', () => {
    const legacy = {
      ...config,
      environments: {
        production: { ...environments.production, branch: undefined },
        staging: { ...environments.staging, branch: undefined },
      },
    };
    delete legacy.environments.production.branch;
    delete legacy.environments.staging.branch;
    expect(
      pipelineDeployTargets(legacy, {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/akash',
      })
    ).toEqual(['production', 'staging']);
  });
});
