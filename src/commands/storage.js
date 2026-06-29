import inquirer from 'inquirer';
import chalk from 'chalk';
import { appendEnv, loadEnv } from '../core/config.js';
import { testProvider, testAllProviders } from '../storage/index.js';

const PROVIDER_PROMPTS = {
  aws: [
    { key: 'AWS_ACCESS_KEY_ID', message: 'AWS Access Key ID:' },
    { key: 'AWS_SECRET_ACCESS_KEY', message: 'AWS Secret Access Key:', type: 'password' },
    { key: 'AWS_BUCKET', message: 'AWS Bucket name:' },
    { key: 'AWS_REGION', message: 'AWS Region:', default: 'us-east-1' },
  ],
  azure: [
    { key: 'AZURE_CONNECTION_STRING', message: 'Azure Connection String:', type: 'password' },
    { key: 'AZURE_CONTAINER', message: 'Azure Container name:' },
  ],
  gcp: [
    { key: 'GCP_PROJECT_ID', message: 'GCP Project ID:' },
    { key: 'GCP_KEY_FILE', message: 'Path to GCP key file:' },
    { key: 'GCP_BUCKET', message: 'GCP Bucket name:' },
  ],
  gdrive: [
    { key: 'GDRIVE_CLIENT_ID', message: 'Google Drive Client ID:' },
    { key: 'GDRIVE_CLIENT_SECRET', message: 'Google Drive Client Secret:', type: 'password' },
    { key: 'GDRIVE_REFRESH_TOKEN', message: 'Google Drive Refresh Token:', type: 'password' },
    { key: 'GDRIVE_FOLDER_ID', message: 'Google Drive Folder ID (optional):' },
  ],
  dropbox: [
    { key: 'DROPBOX_ACCESS_TOKEN', message: 'Dropbox Access Token:', type: 'password' },
  ],
  ftp: [
    { key: 'FTP_HOST', message: 'FTP Host:' },
    { key: 'FTP_USER', message: 'FTP User:' },
    { key: 'FTP_PASSWORD', message: 'FTP Password:', type: 'password' },
    { key: 'FTP_PORT', message: 'FTP Port:', default: '21' },
  ],
  local: [],
};

/**
 * @param {import('commander').Command} program
 */
export function registerStorageCommand(program) {
  const storage = program
    .command('storage')
    .description('Manage storage providers');

  storage
    .command('add <provider>')
    .description('Add credentials for a storage provider')
    .action(async (provider) => {
      loadEnv();
      const prompts = PROVIDER_PROMPTS[provider];
      if (!prompts) {
        console.error(chalk.red(`Unknown provider: ${provider}`));
        console.log('Available: aws, azure, gcp, gdrive, dropbox, local, ftp');
        process.exit(1);
      }

      if (prompts.length === 0) {
        console.log(chalk.green('Local storage requires no credentials.'));
        return;
      }

      const questions = prompts.map((p) => ({
        type: p.type || 'input',
        name: p.key,
        message: p.message,
        default: p.default,
      }));

      const answers = await inquirer.prompt(questions);
      await appendEnv(answers);

      for (const [key, value] of Object.entries(answers)) {
        process.env[key] = value;
      }

      console.log('Testing connection...');
      try {
        await testProvider(provider);
        console.log(chalk.green(`✓ ${provider} connected successfully`));
      } catch (err) {
        console.error(
          chalk.red(`✗ Connection failed: ${err instanceof Error ? err.message : String(err)}`)
        );
        process.exit(1);
      }
    });

  storage
    .command('list')
    .description('List configured storage providers and status')
    .action(async () => {
      loadEnv();
      let config;
      try {
        const { loadConfig } = await import('../core/config.js');
        config = await loadConfig();
      } catch {
        console.error(chalk.red('Run deployhub init first'));
        process.exit(1);
      }

      const results = await testAllProviders(config.storage);
      console.log(chalk.bold('\nStorage Providers:\n'));
      for (const r of results) {
        const icon = r.status === 'connected' ? chalk.green('✓') : chalk.red('✗');
        const extra = r.error ? chalk.gray(` (${r.error})`) : '';
        console.log(`  ${icon} ${r.name}${extra}`);
      }
      console.log('');
    });
}

export default { registerStorageCommand };
