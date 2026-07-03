import { generateEnvExampleContent } from '../src/utils/github-actions.js';

describe('generateEnvExampleContent', () => {
  test('includes storage provider variables for AWS S3 and Google Drive', () => {
    const content = generateEnvExampleContent(['aws', 'gdrive'], [], {});

    expect(content).toContain('# AWS S3');
    expect(content).toContain('AWS_ACCESS_KEY_ID=');
    expect(content).toContain('AWS_REGION=us-east-1');
    expect(content).toContain('# Google Drive');
    expect(content).toContain('GDRIVE_CLIENT_ID=');
    expect(content).toContain('GDRIVE_FOLDER_ID=');
  });

  test('includes SSH deployment variables with inline comments', () => {
    const content = generateEnvExampleContent(
      [],
      ['production'],
      {
        production: {
          deploymentType: 'server',
          type: 'ssh',
          host: '203.0.113.10',
          user: 'ubuntu',
        },
      },
      { projectType: 'frontend', project: 'my-app' }
    );

    expect(content).toContain('# SSH Deployment');
    expect(content).toContain('SSH_HOST=203.0.113.10');
    expect(content).toContain('SSH_USER=ubuntu');
    expect(content).toContain('SSH_KEY_PATH=');
    expect(content).toContain('Path to your PRIVATE SSH key file');
  });

  test('includes EC2-specific optional variables', () => {
    const content = generateEnvExampleContent(
      [],
      ['production'],
      { production: { type: 'ec2' } },
      { projectType: 'backend', project: 'my-api', port: 3000 }
    );

    expect(content).toContain('# AWS EC2 Deployment');
    expect(content).toContain('EC2_INSTANCE_ID=');
    expect(content).toContain('SSH_APP_NAME=');
  });

  test('includes Kubernetes variables with comments', () => {
    const content = generateEnvExampleContent(
      [],
      ['production'],
      {
        production: {
          type: 'kubernetes',
          kubeNamespace: 'my-app',
        },
      },
      { projectType: 'frontend', project: 'my-app' }
    );

    expect(content).toContain('# Kubernetes Deployment');
    expect(content).toContain('KUBE_CONTEXT=');
    expect(content).toContain('kubectl config get-contexts');
  });

  test('returns placeholder when no providers are configured', () => {
    const content = generateEnvExampleContent([], [], {});

    expect(content).toBe('# Add your environment variables here\n');
  });
});
