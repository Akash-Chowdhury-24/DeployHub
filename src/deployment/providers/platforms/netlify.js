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
export function createNetlifyProvider(config, envName, env = process.env) {
  const environment = config.environments[envName];
  const log = createLogger('netlify');
  const authToken = env.NETLIFY_AUTH_TOKEN;
  const siteId = environment?.siteId || env.NETLIFY_SITE_ID;

  async function deploy(artifactDir) {
    if (!authToken || !siteId) {
      throw new Error('NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID are required');
    }

    const buildDir = resolveBuildOutputPath(config);
    log.info(`Deploying to Netlify from ${buildDir}...`);

    const result = await runCli(
      `netlify deploy --prod --dir="${buildDir}" --auth=${authToken} --site=${siteId}`,
      process.cwd()
    );

    if (result.exitCode !== 0) {
      throw new Error(`Netlify deploy failed: ${result.stderr || result.stdout}`);
    }

    const deployIdMatch = (result.stdout || '').match(/Deploy ID:\s*(\S+)/i);
    const urlMatch = (result.stdout || '').match(/Website URL:\s*(https:\/\/\S+)/i);
    const deployId = deployIdMatch?.[1] || '';
    const deploymentUrl = urlMatch?.[1] || config.healthCheck?.url || '';

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'netlify',
        deploymentUrl,
        deploymentId: deployId,
        siteId,
      },
      envName
    );

    log.success(`Deployed to Netlify: ${deploymentUrl || siteId}`);
  }

  async function rollback(artifactDir) {
    if (!authToken || !siteId) {
      throw new Error('NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID are required');
    }

    const previous = await readPreviousPlatformDeployment(artifactDir);
    const deployId = previous?.deploymentId;
    if (!deployId) {
      throw new Error('No previous Netlify deployment ID found for rollback');
    }

    log.info(`Restoring Netlify deploy ${deployId}...`);
    await axios.post(
      `https://api.netlify.com/api/v1/sites/${siteId}/deploys/${deployId}/restore`,
      {},
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    log.success('Netlify rollback complete');
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;
    return checkUrlHealth(url);
  }

  async function testConnection() {
    if (!authToken) throw new Error('NETLIFY_AUTH_TOKEN is required');
    const response = await axios.get('https://api.netlify.com/api/v1/user', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!response.data?.email) {
      throw new Error('Invalid NETLIFY_AUTH_TOKEN');
    }
    if (siteId) {
      await axios.get(`https://api.netlify.com/api/v1/sites/${siteId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
    }
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createNetlifyProvider };
