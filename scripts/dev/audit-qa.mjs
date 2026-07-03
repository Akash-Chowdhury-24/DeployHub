/**
 * Dev-only: print generated .env.example sections for deployment audit review.
 * Not shipped in the npm package or binary bundle.
 */
import { generateEnvExampleContent } from '../../src/utils/github-actions.js';

const backendConfig = {
  project: 'my-ec2-app',
  version: '1.0.0',
  projectType: 'backend',
  port: 3000,
  framework: 'express',
};

function printSection(title, environments) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(title);
  console.log('='.repeat(60));
  console.log(
    generateEnvExampleContent([], ['production'], environments, backendConfig)
  );
}

printSection('EC2 .env.example (backend)', {
  production: {
    type: 'ec2',
    host: '54.123.45.67',
    user: 'ec2-user',
    deployPath: '/var/www/my-ec2-app',
    appName: 'my-ec2-app',
  },
});

printSection('AZURE-VM .env.example (backend)', {
  production: {
    type: 'azure-vm',
    host: '20.1.2.3',
    user: 'azureuser',
    deployPath: '/var/www/my-app',
    appName: 'my-app',
  },
});

printSection('GCP-VM .env.example (backend)', {
  production: {
    type: 'gcp-vm',
    host: '34.56.78.90',
    user: 'myuser',
    deployPath: '/var/www/my-gcp-app',
    appName: 'my-gcp-app',
  },
});
