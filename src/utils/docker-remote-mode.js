/**
 * Docker remote-host mode only — no node-ssh import.
 * Keep this module free of connection code so deployment-env.js can classify
 * env defs without loading NodeSSH (which would break jest node-ssh mocks).
 *
 * Kubernetes must not honor this: a Kubernetes deploy talks to the cluster via
 * kubectl, not a remote Docker daemon.
 */

/** @typedef {'ssh'|'local'|'raw'} DockerRemoteMode */

/**
 * @param {Record<string, unknown>} [settings]
 * @param {Record<string, string|undefined>} [env]
 * @returns {DockerRemoteMode}
 */
export function resolveDockerRemoteMode(settings = {}, env = process.env) {
  const remote = settings.remote;
  const explicit =
    remote && typeof remote === 'object'
      ? /** @type {Record<string, unknown>} */ (remote).mode
      : undefined;
  if (explicit === 'ssh' || explicit === 'local' || explicit === 'raw') {
    return explicit;
  }
  // Existing configs with a bare DOCKER_HOST keep the unmanaged CLI transport.
  if (settings.dockerHost || env.DOCKER_HOST) {
    return 'raw';
  }
  return 'local';
}

export default { resolveDockerRemoteMode };
