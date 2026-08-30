import { execa } from 'execa';
import { createLogger } from '../../logger/index.js';
import { createDockerImageDeployContext } from '../../utils/docker-image-deploy.js';
import { resolveDockerImageRefForTag } from '../../utils/docker-image.js';
import { resolveDockerContainerName } from '../../utils/docker-container-name.js';
import { getEnvSettings, mergeMethodSettingsIntoEnv } from '../../core/environments.js';
import { createSshExecSession } from '../ssh-connection.js';
import { resolveDockerRemoteMode } from '../../utils/docker-remote-mode.js';
import {
  resolveDockerSshTarget,
  buildRemoteDockerCommands,
} from '../../utils/docker-remote.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createDockerProvider(config, envName, env = process.env) {
  const log = createLogger('docker');
  const settings = getEnvSettings(config.environments?.[envName]);
  const effectiveEnv = mergeMethodSettingsIntoEnv(env, settings);
  const remoteMode = resolveDockerRemoteMode(settings, effectiveEnv);

  // SSH remote runs pull/run/stop/rm over node-ssh. Image build/push still uses
  // the local Docker daemon — never inject DOCKER_HOST into the shared image
  // helpers (kubernetes.js also uses those helpers and has no SSH docker host).
  /** @type {Record<string, string|undefined>} */
  const imageEnv = { ...effectiveEnv };
  if (remoteMode === 'ssh') {
    delete imageEnv.DOCKER_HOST;
    delete imageEnv.DOCKER_TLS_VERIFY;
    delete imageEnv.DOCKER_CERT_PATH;
  }

  const imageOps = createDockerImageDeployContext(config, imageEnv, log);
  const { fullImage, getDockerEnv, ensureImageReadyForDeploy, hasRegistryCredentials } =
    imageOps;
  // Env-scoped like PM2/Nginx — same-daemon multi-env must not share one container name.
  const containerName = resolveDockerContainerName(config, envName);

  function sshTarget() {
    return resolveDockerSshTarget(settings, effectiveEnv);
  }

  function sshSession() {
    const target = sshTarget();
    return createSshExecSession({
      ...target,
      keyPath: target.keyPath ? String(target.keyPath) : undefined,
      env: effectiveEnv,
      log,
    });
  }

  /**
   * @param {string} artifactDir
   * @param {{ fullImage?: string, skipImageReuse?: boolean }} [options]
   */
  async function deploy(artifactDir, options = {}) {
    const imageRef = options.fullImage || fullImage;
    log.info(`Deploying via Docker (image: ${imageRef})...`);

    const result = await ensureImageReadyForDeploy(artifactDir, {
      fullImage: options.fullImage,
      skipImageReuse: options.skipImageReuse,
    });
    if (result.ranCompose) {
      if (remoteMode === 'ssh') {
        throw new Error(
          'docker-compose.yml deploys are not supported with remote.mode "ssh". ' +
            'Use local Docker, advanced raw DOCKER_HOST, or a single-image Dockerfile deploy.'
        );
      }
      log.success('Docker deployment complete');
      return;
    }

    if (remoteMode === 'ssh') {
      await deployOverSsh(imageRef);
      log.success('Docker deployment complete');
      return;
    }

    const dockerEnv = getDockerEnv();

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
   * @param {string} imageRef
   */
  async function deployOverSsh(imageRef) {
    const cmds = buildRemoteDockerCommands(imageRef, containerName);
    const session = sshSession();
    const ssh = await session.connect();
    try {
      const registryUser = imageEnv.DOCKER_REGISTRY_USERNAME || '';
      const registryToken = imageEnv.DOCKER_REGISTRY_TOKEN || '';
      const registryUrl = imageEnv.DOCKER_REGISTRY_URL || '';

      if (registryUser && registryToken) {
        const registry = registryUrl || 'https://index.docker.io/v1/';
        log.info('Logging in to container registry on remote host...');
        await session.exec(ssh, cmds.login(registry, registryUser, registryToken));
      } else if (!hasRegistryCredentials()) {
        log.warn(
          'No DOCKER_REGISTRY_USERNAME/TOKEN — remote docker pull requires a public image or one already present on the host.'
        );
      }

      await session.exec(ssh, cmds.stop);
      await session.exec(ssh, cmds.rm);
      await session.exec(ssh, cmds.pull, {
        timeoutMs: Math.max(session.defaultExecTimeoutMs, 300_000),
      });
      await session.exec(ssh, cmds.run);
    } finally {
      ssh.dispose();
    }
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
      imageEnv,
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
      if (remoteMode === 'ssh') {
        const cmds = buildRemoteDockerCommands(fullImage, containerName);
        const session = sshSession();
        const ssh = await session.connect();
        try {
          const result = await session.exec(ssh, cmds.ps);
          return String(result.stdout || '').includes('Up');
        } finally {
          ssh.dispose();
        }
      }

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
    if (remoteMode === 'ssh') {
      const cmds = buildRemoteDockerCommands(fullImage, containerName);
      const session = sshSession();
      const ssh = await session.connect();
      try {
        await session.exec(ssh, cmds.info);
      } finally {
        ssh.dispose();
      }
      return;
    }
    await execa('docker', ['info'], { stdio: 'pipe', env: getDockerEnv() });
  }

  return { deploy, rollback, healthCheck, testConnection, remoteMode };
}

export default { createDockerProvider };
