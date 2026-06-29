import axios from 'axios';
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
export function createCloudflarePagesProvider(config, envName, env = process.env) {
  const environment = config.environments[envName];
  const log = createLogger('cloudflare-pages');
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = environment?.accountId || env.CLOUDFLARE_ACCOUNT_ID;
  const projectName =
    environment?.projectName || env.CF_PROJECT_NAME || config.project;

  async function deploy(artifactDir) {
    if (!apiToken || !accountId) {
      throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
    }

    const buildDir = resolveBuildOutputPath(config);
    log.info(`Deploying to Cloudflare Pages project "${projectName}"...`);

    const result = await runCli(
      `wrangler pages deploy "${buildDir}" --project-name=${projectName} --branch=main`,
      process.cwd(),
      {
        CLOUDFLARE_API_TOKEN: apiToken,
        CLOUDFLARE_ACCOUNT_ID: accountId,
      }
    );

    if (result.exitCode !== 0) {
      throw new Error(`Cloudflare Pages deploy failed: ${result.stderr || result.stdout}`);
    }

    const urlMatch = (result.stdout || '').match(/https:\/\/[^\s]+\.pages\.dev/);
    const deploymentUrl = urlMatch?.[0] || config.healthCheck?.url || '';

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'cloudflare-pages',
        deploymentUrl,
        deploymentId: deploymentUrl,
        projectName,
        accountId,
      },
      envName
    );

    log.success(`Deployed to Cloudflare Pages: ${deploymentUrl || projectName}`);
  }

  async function rollback(artifactDir) {
    if (!apiToken || !accountId) {
      throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
    }

    const previous = await readPreviousPlatformDeployment(artifactDir);
    const deploymentId = previous?.deploymentId;
    if (!deploymentId) {
      throw new Error('No previous Cloudflare deployment ID found for rollback');
    }

    log.info('Rolling back Cloudflare Pages deployment...');
    await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments/${deploymentId}/rollback`,
      {},
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    log.success('Cloudflare Pages rollback complete');
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;
    return checkUrlHealth(url);
  }

  async function testConnection() {
    if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required');
    const response = await axios.get(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    if (!response.data?.success) {
      throw new Error('Invalid CLOUDFLARE_API_TOKEN');
    }
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createCloudflarePagesProvider };
