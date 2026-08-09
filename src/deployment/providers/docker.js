import { execa } from 'execa';
import { createLogger } from '../../logger/index.js';
import { createDockerImageDeployContext } from '../../utils/docker-image-deploy.js';
import { resolveDockerImageRefForTag } from '../../utils/docker-image.js';
import { resolveDockerContainerName } from '../../utils/docker-container-name.js';
import { getEnvSettings, mergeMethodSettingsIntoEnv } from '../../core/environments.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createDockerProvider(config, envName, env = process.env) {
  const log = createLogger('docker');
  const settings = getEnvSettings(config.environments?.[envName]);
  const effectiveEnv = mergeMethodSettingsIntoEnv(env, settings);
  const imageOps = createDockerImageDeployContext(config, effectiveEnv, log);
  const { fullImage, getDockerEnv, ensureImageReadyForDeploy } = imageOps;
  // Env-scoped like PM2/Nginx — same-daemon multi-env must not share one container name.
  const containerName = resolveDockerContainerName(config, envName);

  /**
   * @param {string} artifactDir
   * @param {{ fullImage?: string, skipImageReuse?: boolean }} [options]
   */
  async function deploy(artifactDir, options = {}) {
    const imageRef = options.fullImage || fullImage;
    log.info(`Deploying via Docker (image: ${imageRef})...`);
    const dockerEnv = getDockerEnv();

    const result = await ensureImageReadyForDeploy(artifactDir, {
      fullImage: options.fullImage,
      skipImageReuse: options.skipImageReuse,
    });
    if (result.ranCompose) {
      log.success('Docker deployment complete');
      return;
    }

    await execa(
      'docker',
      ['rm', '-f', containerName],
      { stdio: 'pipe', env: dockerEnv }
    ).catch(() => {});

    await execa('docker', ['run', '-d', '--rm', '--name', containerName, imageRef], {
      stdio: 'inherit',
      env: dockerEnv,
    });

    log.success('Docker deployment complete');
  }

  /**
   * @param {string} artifactDir
   * @param {{ buildId?: string, semver?: string, remoteKey?: string }} [meta]
   */
  async function rollback(artifactDir, meta = {}) {
    if (!meta.buildId) {
      throw new Error(
        'Docker rollback requires buildId from the restored artifact history entry'
      );
    }

    // Tag stays buildId-based; env only scopes which history informed this buildId.
    const rollbackImage = resolveDockerImageRefForTag(
      config,
      effectiveEnv,
      meta.buildId
    ).fullImage;
    log.info(
      `Rolling back Docker to buildId=${meta.buildId} (image: ${rollbackImage})...`
    );
    await deploy(artifactDir, {
      fullImage: rollbackImage,
      skipImageReuse: true,
    });
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;

    try {
      const { stdout } = await execa(
        'docker',
        ['ps', '--filter', `name=^/${containerName}$`, '--format', '{{.Status}}'],
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
