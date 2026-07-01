import path from 'path';
import fs from 'fs-extra';
import archiver from 'archiver';
import axios from 'axios';
import { createLogger } from '../../../logger/index.js';
import {
  runCli,
  saveDeploymentRecord,
  readPreviousPlatformDeployment,
  checkUrlHealth,
} from './_shared.js';

const BLOCKING_AMPLIFY_JOB_STATUSES = new Set([
  'CREATED',
  'PENDING',
  'PROVISIONING',
  'RUNNING',
  'CANCELLING',
]);

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} sourceDir
 * @param {string} zipPath
 */
async function createRootZip(sourceDir, zipPath) {
  await fs.ensureDir(path.dirname(zipPath));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * @param {string} zipPath
 * @param {string} uploadUrl
 */
async function uploadZipToAmplify(zipPath, uploadUrl) {
  await axios.put(uploadUrl, fs.createReadStream(zipPath), {
    headers: { 'Content-Type': 'application/zip' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

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
  const branch = environment?.branch || env.AMPLIFY_BRANCH || 'main';
  const githubConnected = environment?.githubConnected ?? false;

  function getAwsEnv() {
    return {
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID || '',
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY || '',
      AWS_DEFAULT_REGION: region,
    };
  }

  /**
   * @param {string} stage
   */
  function resolveAmplifyStage(stage) {
    const normalized = stage.toLowerCase();
    if (normalized === 'production') return 'PRODUCTION';
    if (normalized === 'staging') return 'BETA';
    return 'DEVELOPMENT';
  }

  async function branchExists(awsEnv) {
    const result = await runCli(
      `aws amplify get-branch --app-id ${appId} --branch-name ${branch}`,
      process.cwd(),
      awsEnv
    );
    return result.exitCode === 0;
  }

  async function ensureBranchExists(awsEnv) {
    if (await branchExists(awsEnv)) return;

    if (githubConnected) {
      throw new Error(
        `Amplify branch "${branch}" not found. Connect your GitHub repo in the Amplify console or choose a branch that already exists.`
      );
    }

    const stage = resolveAmplifyStage(envName);
    log.info(`Creating Amplify branch "${branch}" for manual zip deploys...`);
    const createResult = await runCli(
      `aws amplify create-branch --app-id ${appId} --branch-name ${branch} --stage ${stage} --no-enable-auto-build --description "Created by DeployHub for manual deployments"`,
      process.cwd(),
      awsEnv
    );
    if (createResult.exitCode !== 0) {
      throw new Error(`Amplify create-branch failed: ${createResult.stderr || createResult.stdout}`);
    }
    log.success(`Amplify branch "${branch}" ready`);
  }

  /**
   * @param {Record<string, string>} awsEnv
   * @returns {Promise<{ jobId?: string, status?: string }[]>}
   */
  async function listBranchJobs(awsEnv) {
    const result = await runCli(
      `aws amplify list-jobs --app-id ${appId} --branch-name ${branch} --max-items 10 --output json`,
      process.cwd(),
      awsEnv
    );
    if (result.exitCode !== 0) return [];

    try {
      const data = JSON.parse(result.stdout);
      return data.jobSummaries || [];
    } catch {
      return [];
    }
  }

  /**
   * Cancel stuck jobs left by failed uploads so create-deployment can proceed.
   * @param {Record<string, string>} awsEnv
   */
  async function clearBlockingAmplifyJobs(awsEnv) {
    const jobs = await listBranchJobs(awsEnv);
    const blocking = jobs.filter((job) =>
      BLOCKING_AMPLIFY_JOB_STATUSES.has(job.status || '')
    );

    if (blocking.length === 0) return;

    for (const job of blocking) {
      log.info(`Stopping in-progress Amplify job ${job.jobId} (${job.status})...`);
      const stopResult = await runCli(
        `aws amplify stop-job --app-id ${appId} --branch-name ${branch} --job-id ${job.jobId}`,
        process.cwd(),
        awsEnv
      );
      if (stopResult.exitCode !== 0) {
        log.warn(
          `Could not stop Amplify job ${job.jobId}: ${stopResult.stderr || stopResult.stdout}`
        );
      }
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(5000);
      const current = await listBranchJobs(awsEnv);
      const stillBlocking = current.filter((job) =>
        BLOCKING_AMPLIFY_JOB_STATUSES.has(job.status || '')
      );
      if (stillBlocking.length === 0) {
        log.info('Amplify branch is ready for a new deployment');
        return;
      }
    }

    throw new Error(
      'Timed out waiting for in-progress Amplify jobs to finish. Stop them in the AWS console and retry.'
    );
  }

  /**
   * @param {Record<string, string>} awsEnv
   * @returns {Promise<Record<string, unknown>>}
   */
  async function createManualDeployment(awsEnv) {
    await clearBlockingAmplifyJobs(awsEnv);

    const createResult = await runCli(
      `aws amplify create-deployment --app-id ${appId} --branch-name ${branch} --output json`,
      process.cwd(),
      awsEnv
    );
    if (createResult.exitCode !== 0) {
      const errorText = `${createResult.stderr || ''}${createResult.stdout || ''}`;
      if (/was not finished/i.test(errorText)) {
        log.warn('Amplify has a stuck deployment — clearing it and retrying...');
        await clearBlockingAmplifyJobs(awsEnv);
        const retryResult = await runCli(
          `aws amplify create-deployment --app-id ${appId} --branch-name ${branch} --output json`,
          process.cwd(),
          awsEnv
        );
        if (retryResult.exitCode !== 0) {
          throw new Error(`Amplify create-deployment failed: ${retryResult.stderr}`);
        }
        return JSON.parse(retryResult.stdout);
      }
      throw new Error(`Amplify create-deployment failed: ${createResult.stderr}`);
    }

    return JSON.parse(createResult.stdout);
  }

  async function deploy(artifactDir) {
    if (!appId) throw new Error('AMPLIFY_APP_ID is required');

    const awsEnv = getAwsEnv();

    if (githubConnected) {
      await ensureBranchExists(awsEnv);
      log.info(`Triggering Amplify release job on branch ${branch} (GitHub connected)...`);
      const result = await runCli(
        `aws amplify start-job --app-id ${appId} --branch-name ${branch} --job-type RELEASE`,
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
          branch,
          method: 'github',
        },
        envName
      );
      log.success(`Amplify job started: ${jobId || 'RELEASE'}`);
      return;
    }

    log.info(`Uploading build output to Amplify branch ${branch}...`);
    await ensureBranchExists(awsEnv);

    const buildOutput = config.frontend?.buildOutput || config.buildOutput || 'dist';
    const buildDir = path.join(process.cwd(), buildOutput);
    if (!(await fs.pathExists(buildDir))) {
      throw new Error(
        `Build output not found at ${buildOutput}. Amplify needs the built static files, not artifact.zip with a nested folder.`
      );
    }

    const amplifyZipPath = path.join(artifactDir, 'amplify-deploy.zip');
    await createRootZip(buildDir, amplifyZipPath);

    const deployment = await createManualDeployment(awsEnv);
    const jobId = deployment.jobId;
    const zipUploadUrl = deployment.zipUploadUrl;

    log.info('Uploading zip to Amplify...');
    await uploadZipToAmplify(amplifyZipPath, zipUploadUrl);

    const startResult = await runCli(
      `aws amplify start-deployment --app-id ${appId} --branch-name ${branch} --job-id ${jobId}`,
      process.cwd(),
      awsEnv
    );
    if (startResult.exitCode !== 0) {
      throw new Error(`Amplify start-deployment failed: ${startResult.stderr}`);
    }

    await fs.remove(amplifyZipPath);

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'aws-amplify',
        deploymentId: jobId,
        appId,
        branch,
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

    const awsEnv = getAwsEnv();
    const rollbackBranch = previous?.branch || branch;

    log.info(`Re-triggering Amplify job ${jobId} on branch ${rollbackBranch}...`);
    const result = await runCli(
      `aws amplify start-job --app-id ${appId} --branch-name ${rollbackBranch} --job-id ${jobId} --job-type RETRY`,
      process.cwd(),
      awsEnv
    );
    if (result.exitCode !== 0) {
      await runCli(
        `aws amplify start-job --app-id ${appId} --branch-name ${rollbackBranch} --job-type RELEASE`,
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

    const awsEnv = getAwsEnv();
    const appResult = await runCli(
      `aws amplify get-app --app-id ${appId}`,
      process.cwd(),
      awsEnv
    );
    if (appResult.exitCode !== 0) {
      throw new Error('Could not find Amplify app — check AMPLIFY_APP_ID and AWS credentials');
    }

    if (await branchExists(awsEnv)) return;

    if (githubConnected) {
      throw new Error(
        `Amplify branch "${branch}" not found. Connect your GitHub repo in the Amplify console or choose a branch that already exists.`
      );
    }

    log.info(
      `Amplify branch "${branch}" will be created automatically on the first deploy`
    );
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createAwsAmplifyProvider };
