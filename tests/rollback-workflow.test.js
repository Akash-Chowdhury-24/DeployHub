import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  extractWorkflowSecretKeys,
  writeWorkflowFile,
  getCliRollbackCommand,
  DEPLOY_WORKFLOW_FILENAME,
  ROLLBACK_WORKFLOW_FILENAME,
} from '../src/utils/github-actions.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

/** @type {Array<{ type: string, storage?: string[] }>} */
const DEPLOY_METHODS = [
  { type: 'kubernetes', storage: ['aws'] },
  { type: 'docker', storage: ['aws'] },
  { type: 'ssh', storage: ['aws'] },
  { type: 'ec2', storage: ['aws'] },
  { type: 'azure-vm', storage: ['azure'] },
  { type: 'gcp-vm', storage: ['gcp'] },
];

describe('generateRollbackWorkflowYaml', () => {
  test.each(DEPLOY_METHODS)(
    'generates workflow_dispatch rollback for $type',
    ({ type, storage }) => {
      const environments = { production: { type } };
      const yaml = generateRollbackWorkflowYaml(
        storage || ['local'],
        ['production'],
        environments,
        CLI,
        { projectType: 'frontend', project: 'demo' }
      );

      expect(yaml).toContain('name: DeployHub Rollback');
      expect(yaml).toContain('workflow_dispatch:');
      expect(yaml).toContain('buildId:');
      expect(yaml).toContain('required: false');
      expect(yaml).not.toContain('push:');
      expect(yaml).toContain(getCliRollbackCommand());
      expect(yaml).toContain('if [ -n "${{ inputs.buildId }}" ]; then');
      expect(yaml).toContain(`${getCliRollbackCommand()} "\${{ inputs.buildId }}"`);
      expect(yaml).toContain('Install DeployHub CLI');
      expect(yaml).not.toContain('Install project dependencies');
      expect(yaml).not.toContain('deployhub build');
    }
  );

  test('kubernetes rollback includes kubectl setup and registry secrets', () => {
    const yaml = generateRollbackWorkflowYaml(
      ['aws'],
      ['production'],
      { production: { type: 'kubernetes' } },
      CLI,
      { projectType: 'frontend', project: 'demo' }
    );

    expect(yaml).toContain('azure/setup-kubectl@v4');
    expect(yaml).toContain('Configure kubeconfig');
    expect(yaml).toContain('KUBECONFIG: ${{ github.workspace }}/.kube/config');
    expect(yaml).toContain('DOCKER_REGISTRY_USERNAME: ${{ secrets.DOCKER_REGISTRY_USERNAME }}');
    expect(yaml).toContain('DOCKER_REGISTRY_TOKEN: ${{ secrets.DOCKER_REGISTRY_TOKEN }}');
    expect(yaml).toContain('AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}');
    expect(yaml).not.toContain('SSH_HOST:');
  });

  test('ssh rollback includes SSH secrets and omits kubeconfig', () => {
    const yaml = generateRollbackWorkflowYaml(
      ['aws'],
      ['production'],
      { production: { type: 'ssh' } },
      CLI
    );

    expect(yaml).toContain('SSH_HOST: ${{ secrets.SSH_HOST }}');
    expect(yaml).toContain('SSH_USER: ${{ secrets.SSH_USER }}');
    expect(yaml).not.toContain('azure/setup-kubectl');
    expect(yaml).not.toContain('KUBECONFIG:');
    expect(yaml).not.toContain('DOCKER_REGISTRY_USERNAME:');
  });

  test('docker rollback includes registry secrets and omits SSH/kube', () => {
    const yaml = generateRollbackWorkflowYaml(
      ['local'],
      ['production'],
      { production: { type: 'docker' } },
      CLI
    );

    expect(yaml).toContain('DOCKER_IMAGE_NAME:');
    expect(yaml).not.toContain('SSH_HOST:');
    expect(yaml).not.toContain('azure/setup-kubectl');
  });
});

describe('deploy vs rollback secret-key parity', () => {
  test.each(DEPLOY_METHODS)(
    'rollback env secret keys === deploy env secret keys for $type',
    ({ type, storage }) => {
      const environments = { production: { type } };
      const storageProviders = storage || ['local'];
      const config = { projectType: 'frontend', project: 'demo' };

      const deployYaml = generateWorkflowYaml(
        storageProviders,
        ['production'],
        environments,
        CLI,
        config
      );
      const rollbackYaml = generateRollbackWorkflowYaml(
        storageProviders,
        ['production'],
        environments,
        CLI,
        config
      );

      expect(extractWorkflowSecretKeys(rollbackYaml)).toEqual(
        extractWorkflowSecretKeys(deployYaml)
      );
    }
  );
});

describe('writeWorkflowFile writes both workflows', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-workflows-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('creates deployhub.yml and deployhub-rollback.yml', async () => {
    await writeWorkflowFile(
      ['aws'],
      ['production'],
      { production: { type: 'kubernetes' } },
      tmp,
      CLI,
      { projectType: 'frontend', project: 'app' }
    );

    const deployPath = path.join(tmp, '.github', 'workflows', DEPLOY_WORKFLOW_FILENAME);
    const rollbackPath = path.join(tmp, '.github', 'workflows', ROLLBACK_WORKFLOW_FILENAME);

    expect(await fs.pathExists(deployPath)).toBe(true);
    expect(await fs.pathExists(rollbackPath)).toBe(true);

    const deploy = await fs.readFile(deployPath, 'utf8');
    const rollback = await fs.readFile(rollbackPath, 'utf8');
    expect(deploy).toContain('name: DeployHub');
    expect(rollback).toContain('name: DeployHub Rollback');
    expect(rollback).toContain('workflow_dispatch:');
  });
});
