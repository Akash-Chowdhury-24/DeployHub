import { execa } from 'execa';
import { createLogger } from '../../logger/index.js';
import { createDockerImageDeployContext } from '../../utils/docker-image-deploy.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createDockerProvider(config, envName, env = process.env) {
  const log = createLogger('docker');
  const imageOps = createDockerImageDeployContext(config, env, log);
  const { fullImage, getDockerEnv, ensureImageReadyForDeploy } = imageOps;

  /**
   * @param {string} artifactDir
   */
  async function deploy(artifactDir) {
    log.info(`Deploying via Docker (image: ${fullImage})...`);
    const dockerEnv = getDockerEnv();

    const result = await ensureImageReadyForDeploy(artifactDir);
    if (result.ranCompose) {
      log.success('Docker deployment complete');
      return;
    }

    await execa(
      'docker',
      ['rm', '-f', config.project],
      { stdio: 'pipe', env: dockerEnv }
    ).catch(() => {});

    await execa('docker', ['run', '-d', '--rm', '--name', config.project, fullImage], {
      stdio: 'inherit',
      env: dockerEnv,
    });

    log.success('Docker deployment complete');
  }

  async function rollback(artifactDir) {
    log.info('Rolling back Docker deployment (redeploy previous artifact)...');
    await deploy(artifactDir);
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;

    try {
      const { stdout } = await execa(
        'docker',
        ['ps', '--filter', `name=${config.project}`, '--format', '{{.Status}}'],
        { stdio: 'pipe', env: getDockerEnv() }
      );
      return stdout.includes('Up');
    } catch {
      return false;
    }
  }

  async function testConnection() {
    await execa('docker', ['info'], { stdio: 'pipe', env: getDockerEnv() });
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createDockerProvider };
