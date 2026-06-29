import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { createLogger } from '../../../logger/index.js';
import {
  runCli,
  saveDeploymentRecord,
  readPreviousPlatformDeployment,
  checkUrlHealth,
} from './_shared.js';

/**
 * @param {import('../../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createAwsAmplifyProvider(config, envName, env = process.env) {
  const environment = config.environments[envName];
  const log = createLogger('aws-amplify');
  const appId = environment?.appId || env.AMPLIFY_APP_ID;
  const region = environment?.region || env.AWS_REGION || 'us-east-1';
  const githubConnected = environment?.githubConnected ?? false;

  async function deploy(artifactDir) {
    if (!appId) throw new Error('AMPLIFY_APP_ID is required');

    const awsEnv = {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID || '',
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY || '',
      AWS_DEFAULT_REGION: region,
    };

    if (githubConnected) {
      log.info('Triggering Amplify release job (GitHub connected)...');
      const result = await runCli(
        `aws amplify start-job --app-id ${appId} --branch-name main --job-type RELEASE`,
        process.cwd(),
        awsEnv
      );
      if (result.exitCode !== 0) {
        throw new Error(`Amplify start-job failed: ${result.stderr || result.stdout}`);
      }

      const jobMatch = (result.stdout || '').match(/"jobId":\s*"([^"]+)"/);
      const jobId = jobMatch?.[1] || '';

      await saveDeploymentRecord(
        artifactDir,
        {
          platform: 'aws-amplify',
          deploymentId: jobId,
          appId,
          method: 'github',
        },
        envName
      );
      log.success(`Amplify job started: ${jobId || 'RELEASE'}`);
      return;
    }

    log.info('Uploading artifact zip to Amplify...');
    const zipPath = path.join(artifactDir, 'artifact.zip');
    if (!(await fs.pathExists(zipPath))) {
      throw new Error('artifact.zip not found for Amplify upload');
    }

    const createResult = await runCli(
      `aws amplify create-deployment --app-id ${appId} --branch-name main --output json`,
      process.cwd(),
      awsEnv
    );
    if (createResult.exitCode !== 0) {
      throw new Error(`Amplify create-deployment failed: ${createResult.stderr}`);
    }

    const deployment = JSON.parse(createResult.stdout);
    const jobId = deployment.jobId;
    const zipUploadUrl = deployment.zipUploadUrl;

    await execa('curl', ['-T', zipPath, zipUploadUrl], {
      env: { ...process.env, ...awsEnv },
      stdio: 'inherit',
      shell: true,
    });

    const startResult = await runCli(
      `aws amplify start-deployment --app-id ${appId} --branch-name main --job-id ${jobId}`,
      process.cwd(),
      awsEnv
    );
    if (startResult.exitCode !== 0) {
      throw new Error(`Amplify start-deployment failed: ${startResult.stderr}`);
    }

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'aws-amplify',
        deploymentId: jobId,
        appId,
        method: 'zip',
      },
      envName
    );
    log.success(`Amplify deployment started: job ${jobId}`);
  }

  async function rollback(artifactDir) {
    if (!appId) throw new Error('AMPLIFY_APP_ID is required');

    const previous = await readPreviousPlatformDeployment(artifactDir);
    const jobId = previous?.deploymentId;
    if (!jobId) {
      throw new Error('No previous Amplify job ID found for rollback');
    }

    const awsEnv = {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID || '',
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY || '',
      AWS_DEFAULT_REGION: region,
    };

    log.info(`Re-triggering Amplify job ${jobId}...`);
    const result = await runCli(
      `aws amplify start-job --app-id ${appId} --branch-name main --job-id ${jobId} --job-type RETRY`,
      process.cwd(),
      awsEnv
    );
    if (result.exitCode !== 0) {
      await runCli(
        `aws amplify start-job --app-id ${appId} --branch-name main --job-type RELEASE`,
        process.cwd(),
        awsEnv
      );
    }
    log.success('Amplify rollback triggered');
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;
    return checkUrlHealth(url);
  }

  async function testConnection() {
    if (!appId) throw new Error('AMPLIFY_APP_ID is required');
    const result = await runCli(
      `aws amplify get-app --app-id ${appId}`,
      process.cwd(),
      {
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID || '',
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY || '',
        AWS_DEFAULT_REGION: region,
      }
    );
    if (result.exitCode !== 0) {
      throw new Error('Could not find Amplify app — check AMPLIFY_APP_ID and AWS credentials');
    }
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createAwsAmplifyProvider };
