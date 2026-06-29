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
export function createVercelProvider(config, envName, env = process.env) {
  const log = createLogger('vercel');
  const token = env.VERCEL_TOKEN;
  const orgId = env.VERCEL_ORG_ID;
  const projectId = env.VERCEL_PROJECT_ID;

  async function deploy(artifactDir) {
    if (!token) throw new Error('VERCEL_TOKEN is required');

    log.info('Deploying to Vercel...');
    const cwd = process.cwd();
    const deployEnv = {
      VERCEL_ORG_ID: orgId || '',
      VERCEL_PROJECT_ID: projectId || '',
    };

    const result = await runCli(
      `vercel deploy --prod --token=${token} --yes`,
      cwd,
      deployEnv
    );

    if (result.exitCode !== 0) {
      throw new Error(`Vercel deploy failed: ${result.stderr || result.stdout}`);
    }

    const output = result.stdout || '';
    const urlMatch = output.match(/https:\/\/[^\s]+\.vercel\.app/);
    const deploymentUrl = urlMatch ? urlMatch[0] : config.healthCheck?.url || '';

    await saveDeploymentRecord(
      artifactDir,
      {
        platform: 'vercel',
        deploymentUrl,
        deploymentId: deploymentUrl,
      },
      envName
    );

    log.success(`Deployed to Vercel: ${deploymentUrl || 'production'}`);
  }

  async function rollback(artifactDir) {
    if (!token) throw new Error('VERCEL_TOKEN is required');

    const previous = await readPreviousPlatformDeployment(artifactDir);
    const deploymentUrl = previous?.deploymentUrl || previous?.deploymentId;

    log.info('Rolling back on Vercel...');
    const cmd = deploymentUrl
      ? `vercel rollback ${deploymentUrl} --token=${token} --yes`
      : `vercel rollback --token=${token} --yes`;

    const result = await runCli(cmd, process.cwd());
    if (result.exitCode !== 0) {
      throw new Error(`Vercel rollback failed: ${result.stderr || result.stdout}`);
    }
    log.success('Vercel rollback complete');
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;
    return checkUrlHealth(url);
  }

  async function testConnection() {
    if (!token) throw new Error('VERCEL_TOKEN is required');
    const result = await runCli(`vercel whoami --token=${token}`, process.cwd());
    if (result.exitCode !== 0) {
      throw new Error('Invalid VERCEL_TOKEN');
    }
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createVercelProvider };
