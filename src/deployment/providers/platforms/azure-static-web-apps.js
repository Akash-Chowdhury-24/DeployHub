import { createLogger } from '../../../logger/index.js';
import {
  runCli,
  saveDeploymentRecord,
  readPreviousPlatformDeployment,
  checkUrlHealth,
  resolveBuildOutputPath,
} from './_shared.js';

/**
 * @param {import('../../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createAzureStaticWebAppsProvider(config, envName, env = process.env) {
  const environment = config.environments[envName];
  const log = createLogger('azure-swa');
  const token = env.AZURE_STATIC_WEB_APPS_TOKEN;
  const resourceName = environment?.resourceName || config.project;

  async function deploy(artifactDir) {
    if (!token) throw new Error('AZURE_STATIC_WEB_APPS_TOKEN is required');

    const buildDir = resolveBuildOutputPath(config);
    log.info(`Deploying to Azure Static Web Apps (${resourceName})...`);

    const result = await runCli(
      `swa deploy "${buildDir}" --deployment-token=${token}`,
      process.cwd()
    );

    if (result.exitCode !== 0) {
      throw new Error(`Azure SWA deploy failed: ${result.stderr || result.stdout}`);
    }

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'azure-static-web-apps',
        deploymentId: `swa-${Date.now()}`,
        resourceName,
        deploymentUrl: config.healthCheck?.url || '',
      },
      envName
    );

    log.success('Deployed to Azure Static Web Apps');
  }

  async function rollback(artifactDir) {
    log.info('Azure SWA has no native rollback — re-deploying previous artifact...');
    await deploy(artifactDir);
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;
    return checkUrlHealth(url);
  }

  async function testConnection() {
    if (!token) throw new Error('AZURE_STATIC_WEB_APPS_TOKEN is required');
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createAzureStaticWebAppsProvider };
