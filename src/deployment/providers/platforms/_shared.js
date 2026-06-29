import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';

/**
 * @param {import('../../../core/config.js').DeployHubConfig} config
 * @returns {string}
 */
export function getBuildOutputDir(config) {
  if (config.projectType === 'both' && config.frontend?.buildOutput) {
    return config.frontend.buildOutput;
  }
  return config.buildOutput || 'dist';
}

/**
 * @param {import('../../../core/config.js').DeployHubConfig} config
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolveBuildOutputPath(config, cwd = process.cwd()) {
  return path.join(cwd, getBuildOutputDir(config));
}

/**
 * @param {string} artifactDir
 * @param {Record<string, unknown>} record
 * @param {string} [environmentName]
 */
export async function saveDeploymentRecord(artifactDir, record, environmentName = '') {
  const deploymentPath = path.join(artifactDir, 'deployment.json');
  let existing = { targets: [], deployedAt: new Date().toISOString(), deployments: [] };

  if (await fs.pathExists(deploymentPath)) {
    existing = await fs.readJson(deploymentPath);
  }

  const timestamp = new Date().toISOString();
  const envName = record.environmentName || environmentName || record.envName || '';

  /** @type {Record<string, unknown>} */
  const entry = {
    ...record,
    platform: record.platform,
    deployId: record.deployId || record.deploymentId || '',
    deployUrl: record.deployUrl || record.deploymentUrl || '',
    deploymentId: record.deploymentId || record.deployId || '',
    deploymentUrl: record.deploymentUrl || record.deployUrl || '',
    timestamp,
    environmentName: envName,
  };

  const deployments = existing.deployments || existing.platformDeployments || [];
  deployments.push(entry);

  await fs.writeJson(
    deploymentPath,
    {
      ...existing,
      deployments,
      platformDeployments: deployments,
      lastDeployment: entry,
      deployedAt: timestamp,
    },
    { spaces: 2 }
  );
}

/**
 * @param {string} artifactDir
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function readLastPlatformDeployment(artifactDir) {
  const deploymentPath = path.join(artifactDir, 'deployment.json');
  if (!(await fs.pathExists(deploymentPath))) return null;
  const data = await fs.readJson(deploymentPath);
  const deployments = data.deployments || data.platformDeployments || [];
  return data.lastDeployment || deployments.at(-1) || null;
}

/**
 * @param {string} artifactDir
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function readPreviousPlatformDeployment(artifactDir) {
  const deploymentPath = path.join(artifactDir, 'deployment.json');
  if (!(await fs.pathExists(deploymentPath))) return null;
  const data = await fs.readJson(deploymentPath);
  const deployments = data.deployments || data.platformDeployments || [];
  if (deployments.length < 2) return null;
  return deployments[deployments.length - 2];
}

/**
 * @param {string} artifactDir
 * @param {string} [environmentName]
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function readDeploymentForEnvironment(artifactDir, environmentName) {
  const deploymentPath = path.join(artifactDir, 'deployment.json');
  if (!(await fs.pathExists(deploymentPath))) return null;
  const data = await fs.readJson(deploymentPath);
  const deployments = data.deployments || data.platformDeployments || [];
  if (environmentName) {
    const match = deployments.filter((d) => d.environmentName === environmentName);
    return match.at(-1) || null;
  }
  return data.lastDeployment || deployments.at(-1) || null;
}

/**
 * @param {string} command
 * @param {string} [cwd]
 * @param {Record<string, string>} [env]
 */
export async function runCli(command, cwd = process.cwd(), env = process.env) {
  const [cmd, ...args] = command.split(' ');
  const result = await execa(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    reject: false,
  });
  return result;
}

/**
 * @param {string} binary
 * @returns {Promise<boolean>}
 */
export async function isCliInstalled(binary) {
  try {
    const result = await execa(binary, ['--version'], { reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function checkUrlHealth(url) {
  try {
    const axios = (await import('axios')).default;
    const response = await axios.get(url, {
      timeout: 30000,
      validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

export default {
  getBuildOutputDir,
  resolveBuildOutputPath,
  saveDeploymentRecord,
  readLastPlatformDeployment,
  readPreviousPlatformDeployment,
  readDeploymentForEnvironment,
  runCli,
  isCliInstalled,
  checkUrlHealth,
};
