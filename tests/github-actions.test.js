import {
  generateWorkflowYaml,
  getRequiredSecrets,
  normalizeGithubCliSource,
  isGithubCliSource,
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
});
