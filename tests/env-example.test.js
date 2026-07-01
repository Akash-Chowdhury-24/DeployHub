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

  test('includes platform deployment variables', () => {
    const content = generateEnvExampleContent(
      [],
      ['production'],
      {
        production: {
          deploymentType: 'platform',
          platform: 'vercel',
        },
      }
    );

    expect(content).toContain('# Vercel');
    expect(content).toContain('VERCEL_TOKEN=');
    expect(content).toContain('VERCEL_PROJECT_ID=');
  });

  test('returns placeholder when no providers are configured', () => {
    const content = generateEnvExampleContent([], [], {});

    expect(content).toBe('# Add your environment variables here\n');
  });
});
