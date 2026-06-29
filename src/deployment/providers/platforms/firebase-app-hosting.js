import { createLogger } from '../../../logger/index.js';
import {
  runCli,
  saveDeploymentRecord,
  checkUrlHealth,
} from './_shared.js';

/**
 * @param {import('../../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createFirebaseAppHostingProvider(config, envName, env = process.env) {
  const environment = config.environments[envName];
  const log = createLogger('firebase-app-hosting');
  const token = env.FIREBASE_TOKEN;
  const projectId = environment?.projectId || env.FIREBASE_PROJECT_ID;
  const backendName =
    environment?.backendName || env.FIREBASE_APP_HOSTING_BACKEND || config.project;

  async function deploy(artifactDir) {
    if (!token || !projectId) {
      throw new Error('FIREBASE_TOKEN and FIREBASE_PROJECT_ID are required');
    }

    log.info(`Deploying to Firebase App Hosting (${projectId}/${backendName})...`);

    const createResult = await runCli(
      `firebase apphosting:backends:list --project=${projectId} --token=${token} --non-interactive`,
      process.cwd()
    );

    const backendExists =
      createResult.exitCode === 0 && createResult.stdout.includes(backendName);

    if (!backendExists) {
      log.info(`Creating App Hosting backend "${backendName}"...`);
      await runCli(
        `firebase apphosting:backends:create --project=${projectId} --token=${token} --backend=${backendName} --non-interactive`,
        process.cwd()
      );
    }

    const result = await runCli(
      `firebase deploy --only apphosting --token=${token} --project=${projectId} --non-interactive`,
      process.cwd()
    );

    if (result.exitCode !== 0) {
      throw new Error(`Firebase App Hosting deploy failed: ${result.stderr || result.stdout}`);
    }

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'firebase-app-hosting',
        deploymentId: `apphosting-${Date.now()}`,
        projectId,
        backendName,
        deploymentUrl: config.healthCheck?.url || '',
      },
      envName
    );

    log.success('Deployed to Firebase App Hosting');
  }

  async function rollback(artifactDir) {
    log.info('Firebase App Hosting rollback — re-deploying previous artifact...');
    await deploy(artifactDir);
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
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createFirebaseAppHostingProvider };
