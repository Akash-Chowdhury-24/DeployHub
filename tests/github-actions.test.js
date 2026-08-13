import {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  getRequiredSecrets,
  normalizeGithubCliSource,
  isGithubCliSource,
  resolvePhpVersion,
  DEFAULT_PHP_VERSION,
  GITHUB_CLI_TOKEN_SECRET,
} from '../src/utils/github-actions.js';

describe('github cli source', () => {
  test('normalizeGithubCliSource converts https URLs', () => {
    expect(
      normalizeGithubCliSource('https://github.com/Akash-Chowdhury-24/demo-test-repo-.git')
    ).toBe('github:Akash-Chowdhury-24/demo-test-repo-');
  });

  test('isGithubCliSource detects github: prefix', () => {
    expect(isGithubCliSource('github:user/repo')).toBe(true);
    expect(isGithubCliSource('npm:@akash-chowdhury-24/deployhub')).toBe(false);
  });

  test('workflow configures git auth before npm install for github cli', () => {
    const yaml = generateWorkflowYaml(
      ['aws'],
      [],
      {},
      'github:Akash-Chowdhury-24/demo-test-repo-'
    );

    expect(yaml).toContain('Configure GitHub access for DeployHub CLI');
    expect(yaml).toContain(GITHUB_CLI_TOKEN_SECRET);
    expect(yaml).toContain('ssh://git@github.com/');
    expect(yaml.indexOf('Configure GitHub access')).toBeLessThan(
      yaml.indexOf('Install project dependencies')
    );
  });

  test('workflow omits git config for npm cli source', () => {
    const yaml = generateWorkflowYaml(
      ['aws'],
      [],
      {},
      'npm:@akash-chowdhury-24/deployhub'
    );

    expect(yaml).not.toContain('Configure GitHub access for DeployHub CLI');
  });

  test('workflow runs deployhub via scoped package name', () => {
    const yaml = generateWorkflowYaml(
      ['aws'],
      [],
      {},
      'github:Akash-Chowdhury-24/demo-test-repo-'
    );

    expect(yaml).toContain(
      'node ./node_modules/@akash-chowdhury-24/deployhub/src/cli/index.js build'
    );
    expect(yaml).not.toContain('npx deployhub build');
  });

  test('getRequiredSecrets includes DEPLOYHUB_GITHUB_TOKEN for github cli', () => {
    const secrets = getRequiredSecrets(
      ['aws'],
      [],
      {},
      null,
      'github:user/private-repo'
    );

    expect(secrets).toContain(GITHUB_CLI_TOKEN_SECRET);
    expect(secrets).toContain('AWS_ACCESS_KEY_ID');
  });

  test('workflow installs kubectl and configures kubeconfig for kubernetes deploy', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['production'],
      { production: { type: 'kubernetes' } },
      'npm:@akash-chowdhury-24/deployhub',
      { projectType: 'backend', framework: 'express' }
    );

    expect(yaml).toContain('azure/setup-kubectl@v4');
    expect(yaml).toContain("version: 'v1.30.4'");
    expect(yaml).toContain('Configure kubeconfig');
    expect(yaml).toContain('KUBECONFIG: ${{ github.workspace }}/.kube/config');
    expect(yaml).toContain('KUBE_CONTEXT: ${{ secrets.KUBE_CONTEXT }}');
    expect(yaml.indexOf('Setup kubectl')).toBeLessThan(
      yaml.indexOf('node ./node_modules/@akash-chowdhury-24/deployhub/src/cli/index.js build')
    );
    // Sole env is kubernetes — no conditional if: needed
    expect(yaml).not.toMatch(/name: Setup kubectl\n\s+if:/);
  });

  test('workflow omits kubectl setup when kubernetes is not configured', () => {
    const yaml = generateWorkflowYaml(
      ['aws'],
      [],
      {},
      'npm:@akash-chowdhury-24/deployhub'
    );

    expect(yaml).not.toContain('azure/setup-kubectl@v4');
  });

  test('kubeconfig setup is skipped on push when k8s is manual-only', () => {
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
        trigger: 'manual',
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
    const yaml = generateWorkflowYaml(
      ['aws'],
      ['development', 'production'],
      environments,
      'npm:@akash-chowdhury-24/deployhub',
      config
    );

    expect(yaml).toContain('azure/setup-kubectl@v4');
    expect(yaml).toContain('Configure kubeconfig');
    expect(yaml).toMatch(
      /name: Setup kubectl\n\s+if: github\.event_name == 'workflow_dispatch'/
    );
    expect(yaml).toMatch(
      /name: Configure kubeconfig\n\s+if: github\.event_name == 'workflow_dispatch'/
    );
    expect(yaml).toContain("inputs.environment == 'production'");
    // Must not run unconditionally on push
    expect(yaml).not.toMatch(
      /name: Setup kubectl\n\s+if: github\.event_name == 'push'/
    );
  });

  test('kubeconfig setup runs on push when a push-triggered env uses kubernetes', () => {
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
    const yaml = generateWorkflowYaml(
      ['aws'],
      ['development', 'production'],
      environments,
      'npm:@akash-chowdhury-24/deployhub',
      config
    );

    expect(yaml).toMatch(
      /name: Setup kubectl\n\s+if: github\.event_name == 'push' \|\| /
    );
  });
});

describe('PHP CI setup', () => {
  test('resolvePhpVersion defaults to 8.4 then honors config overrides', () => {
    expect(resolvePhpVersion()).toBe(DEFAULT_PHP_VERSION);
    expect(resolvePhpVersion({})).toBe('8.4');
    expect(resolvePhpVersion({ phpVersion: '8.3' })).toBe('8.3');
    expect(
      resolvePhpVersion({ phpVersion: '8.3', backend: { phpVersion: '8.2' } })
    ).toBe('8.2');
  });

  test('laravel deploy workflow sets up PHP 8.4 + composer before composer install', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['production'],
      { production: { type: 'ec2' } },
      'npm:@akash-chowdhury-24/deployhub',
      {
        projectType: 'backend',
        framework: 'laravel',
        language: 'php',
      }
    );

    expect(yaml).toContain('shivammathur/setup-php@v2');
    expect(yaml).toContain("php-version: '8.4'");
    expect(yaml).toContain('tools: composer');
    expect(yaml).toContain('composer install --no-interaction');
    expect(yaml.indexOf('Setup PHP')).toBeLessThan(
      yaml.indexOf('Install project dependencies')
    );
    expect(yaml.indexOf('actions/checkout@v4')).toBeLessThan(yaml.indexOf('Setup PHP'));
  });

  test('PHP setup is omitted for non-PHP backends', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['production'],
      { production: { type: 'ssh' } },
      'npm:@akash-chowdhury-24/deployhub',
      { projectType: 'backend', framework: 'express', language: 'javascript' }
    );

    expect(yaml).not.toContain('setup-php');
    expect(yaml).not.toContain('composer install');
  });

  test('rollback workflow sets up PHP and runs composer install for Laravel', () => {
    const yaml = generateRollbackWorkflowYaml(
      ['local'],
      ['production'],
      { production: { type: 'ec2' } },
      'npm:@akash-chowdhury-24/deployhub',
      {
        projectType: 'backend',
        framework: 'laravel',
        language: 'php',
        backend: { phpVersion: '8.3' },
      }
    );

    expect(yaml).toContain('shivammathur/setup-php@v2');
    expect(yaml).toContain("php-version: '8.3'");
    expect(yaml).toContain('Install project dependencies');
    expect(yaml).toContain('composer install --no-interaction');
    expect(yaml.indexOf('Setup PHP')).toBeLessThan(
      yaml.indexOf('Install project dependencies')
    );
  });
});
