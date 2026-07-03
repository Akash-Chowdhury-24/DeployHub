import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../../logger/index.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createDockerProvider(config, envName, env = process.env) {
  const log = createLogger('docker');

  const imageName = env.DOCKER_IMAGE_NAME || config.project;
  const imageTag = env.DOCKER_IMAGE_TAG || config.version || 'latest';
  const registryUrl = env.DOCKER_REGISTRY_URL || '';
  const registryUser = env.DOCKER_REGISTRY_USERNAME || '';
  const registryToken = env.DOCKER_REGISTRY_TOKEN || '';
  const dockerHost = env.DOCKER_HOST || '';

  function getDockerEnv() {
    /** @type {Record<string, string>} */
    const dockerEnv = { ...process.env };
    if (dockerHost) dockerEnv.DOCKER_HOST = dockerHost;
    if (env.DOCKER_TLS_VERIFY) dockerEnv.DOCKER_TLS_VERIFY = env.DOCKER_TLS_VERIFY;
    if (env.DOCKER_CERT_PATH) dockerEnv.DOCKER_CERT_PATH = env.DOCKER_CERT_PATH;
    return dockerEnv;
  }

  const fullImage = registryUrl && !imageName.includes('/')
    ? `${registryUrl.replace(/\/$/, '')}/${imageName}:${imageTag}`
    : `${imageName}:${imageTag}`;

  async function dockerLogin() {
    if (!registryUser || !registryToken) return;
    const registry = registryUrl || 'https://index.docker.io/v1/';
    log.info('Logging in to container registry...');
    await execa(
      'docker',
      ['login', registry, '-u', registryUser, '--password-stdin'],
      {
        input: registryToken,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: getDockerEnv(),
      }
    );
  }

  /**
   * @param {string} artifactDir
   */
  async function deploy(artifactDir) {
    log.info(`Deploying via Docker (image: ${fullImage})...`);
    const dockerEnv = getDockerEnv();

    const composePath = path.join(artifactDir, 'docker-compose.yml');
    const dockerfilePath = path.join(artifactDir, 'Dockerfile');

    const hasCompose = await fs.pathExists(composePath);
    const hasDockerfile = await fs.pathExists(dockerfilePath);

    await dockerLogin();

    if (hasCompose) {
      await execa(
        'docker',
        ['compose', 'up', '-d', '--build'],
        { cwd: artifactDir, stdio: 'inherit', env: dockerEnv }
      );
    } else if (hasDockerfile) {
      await execa('docker', ['build', '-t', fullImage, '.'], {
        cwd: artifactDir,
        stdio: 'inherit',
        env: dockerEnv,
      });
      await execa('docker', ['push', fullImage], {
        stdio: 'inherit',
        env: dockerEnv,
      }).catch(() => {
        log.warn('docker push skipped (registry may be local or push not configured)');
      });
      await execa('docker', ['run', '-d', '--rm', '--name', config.project, fullImage], {
        stdio: 'inherit',
        env: dockerEnv,
      });
    } else {
      throw new Error(
        'No Dockerfile or docker-compose.yml found in artifact. Add one to your project or enable Docker in pipeline config.'
      );
    }

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
