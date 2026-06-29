import { createLogger } from '../../../logger/index.js';
import { ensureFirebaseJson } from '../../../utils/firebase-config-generator.js';
import {
  runCli,
  saveDeploymentRecord,
  readPreviousPlatformDeployment,
  checkUrlHealth,
  getBuildOutputDir,
} from './_shared.js';

/**
 * @param {import('../../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createFirebaseHostingProvider(config, envName, env = process.env) {
  const environment = config.environments[envName];
  const log = createLogger('firebase-hosting');
  const token = env.FIREBASE_TOKEN;
  const projectId = environment?.projectId || env.FIREBASE_PROJECT_ID;

  async function deploy(artifactDir) {
    if (!token || !projectId) {
      throw new Error('FIREBASE_TOKEN and FIREBASE_PROJECT_ID are required');
    }

    const cwd = process.cwd();
    const buildOutput = getBuildOutputDir(config);
    await ensureFirebaseJson(buildOutput, cwd);

    log.info(`Deploying to Firebase Hosting (${projectId})...`);
    const result = await runCli(
      `firebase deploy --only hosting --token=${token} --project=${projectId} --non-interactive`,
      cwd
    );

    if (result.exitCode !== 0) {
      throw new Error(`Firebase deploy failed: ${result.stderr || result.stdout}`);
    }

    const urlMatch = (result.stdout || '').match(/Hosting URL:\s*(https:\/\/\S+)/i);
    const deploymentUrl = urlMatch?.[1] || config.healthCheck?.url || '';

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'firebase-hosting',
        deploymentUrl,
        deploymentId: deploymentUrl,
        projectId,
      },
      envName
    );

    log.success(`Deployed to Firebase Hosting: ${deploymentUrl || projectId}`);
  }

  async function rollback(artifactDir) {
    if (!token || !projectId) {
      throw new Error('FIREBASE_TOKEN and FIREBASE_PROJECT_ID are required');
    }

    log.info('Rolling back Firebase Hosting...');
    const result = await runCli(
      `firebase hosting:rollback --token=${token} --project=${projectId} --non-interactive`,
      process.cwd()
    );
    if (result.exitCode !== 0) {
      throw new Error(`Firebase rollback failed: ${result.stderr || result.stdout}`);
    }
    log.success('Firebase Hosting rollback complete');
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;
    return checkUrlHealth(url);
  }

  async function testConnection() {
    if (!token || !projectId) {
      throw new Error('FIREBASE_TOKEN and FIREBASE_PROJECT_ID are required');
    }
    const result = await runCli(
      `firebase projects:list --token=${token} --non-interactive`,
      process.cwd()
    );
    if (result.exitCode !== 0) {
      throw new Error('Invalid FIREBASE_TOKEN');
    }
    if (!result.stdout.includes(projectId)) {
      throw new Error(`Firebase project "${projectId}" not accessible`);
    }
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createFirebaseHostingProvider };
