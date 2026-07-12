import {
  getDeploymentSecretKeys,
  getDeploymentWorkflowSecretKeys,
  getDeploymentSecretChecklistItems,
  formatSecretChecklistLine,
} from '../src/deployment/deployment-env.js';
import {
  generateWorkflowYaml,
  getGithubSecretsChecklist,
  getRequiredSecrets,
} from '../src/utils/github-actions.js';

describe('docker secrets required vs CI wiring', () => {
  test('getDeploymentSecretKeys only requires DOCKER_IMAGE_NAME', () => {
    const keys = getDeploymentSecretKeys('docker');
    expect(keys).toEqual(['DOCKER_IMAGE_NAME']);
  });

  test('getDeploymentWorkflowSecretKeys still wires optional DOCKER_* vars', () => {
    const keys = getDeploymentWorkflowSecretKeys('docker');
    expect(keys).toContain('DOCKER_IMAGE_NAME');
    expect(keys).toContain('DOCKER_IMAGE_TAG');
    expect(keys).toContain('DOCKER_REGISTRY_USERNAME');
    expect(keys).toContain('DOCKER_REGISTRY_TOKEN');
    expect(keys).toContain('DOCKER_HOST');
  });

  test('workflow yaml includes optional docker secrets for CI wiring', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['development'],
      { development: { type: 'docker' } },
      'npm:@akash-chowdhury-24/deployhub',
      { projectType: 'frontend', framework: 'react' }
    );
    expect(yaml).toContain('DOCKER_IMAGE_NAME: ${{ secrets.DOCKER_IMAGE_NAME }}');
    expect(yaml).toContain('DOCKER_REGISTRY_TOKEN: ${{ secrets.DOCKER_REGISTRY_TOKEN }}');
    expect(yaml).toContain('DOCKER_HOST: ${{ secrets.DOCKER_HOST }}');
  });

  test('checklist labels required vs optional for docker and ec2', () => {
    const dockerItems = getDeploymentSecretChecklistItems('docker');
    const dockerImage = dockerItems.find((i) => i.key === 'DOCKER_IMAGE_NAME');
    const dockerHost = dockerItems.find((i) => i.key === 'DOCKER_HOST');
    expect(dockerImage?.required).toBe(true);
    expect(dockerHost?.required).toBe(false);
    expect(formatSecretChecklistLine(dockerImage)).toContain('(required)');
    expect(formatSecretChecklistLine(dockerHost)).toContain('(optional');

    const ec2Items = getDeploymentSecretChecklistItems('ec2');
    const sshHost = ec2Items.find((i) => i.key === 'SSH_HOST');
    const awsKey = ec2Items.find((i) => i.key === 'AWS_ACCESS_KEY_ID');
    expect(sshHost?.required).toBe(true);
    expect(awsKey?.required).toBe(false);
    expect(formatSecretChecklistLine(awsKey)).toMatch(/optional/);
  });

  test('getRequiredSecrets excludes optional docker registry vars', () => {
    const required = getRequiredSecrets(
      ['local'],
      ['development'],
      { development: { type: 'docker' } },
      { projectType: 'frontend' }
    );
    expect(required).toContain('DOCKER_IMAGE_NAME');
    expect(required).not.toContain('DOCKER_REGISTRY_TOKEN');
    expect(required).not.toContain('DOCKER_HOST');
  });

  test('getGithubSecretsChecklist includes optional labeled items', () => {
    const checklist = getGithubSecretsChecklist(
      ['local'],
      ['development'],
      { development: { type: 'docker' } },
      { projectType: 'frontend' }
    );
    const token = checklist.find((i) => i.key === 'DOCKER_REGISTRY_TOKEN');
    expect(token?.required).toBe(false);
  });
});
