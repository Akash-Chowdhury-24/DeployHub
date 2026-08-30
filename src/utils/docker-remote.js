/**
 * Docker remote-host mode: local daemon, first-class SSH (node-ssh), or raw
 * DOCKER_HOST (Docker CLI ssh:// / tcp:// transport).
 *
 * Kubernetes must not import or honor this module — a Kubernetes deploy talks
 * to the cluster via kubectl, not a remote Docker daemon.
 */

import { shellQuote } from './shell-quote.js';
import { createSshExecSession } from '../deployment/ssh-connection.js';
import { resolveDockerRemoteMode } from './docker-remote-mode.js';

export { resolveDockerRemoteMode };

/**
 * SSH identity for docker remote.mode === "ssh".
 * Same env names as ec2 (SSH_HOST / SSH_USER / SSH_KEY_PATH / SSH_KEY).
 * Per-environment prefixing already separates these from a sibling ssh/ec2 env.
 *
 * @param {Record<string, unknown>} settings
 * @param {Record<string, string|undefined>} env
 */
export function resolveDockerSshTarget(settings, env = process.env) {
  const host = String(settings.host || env.SSH_HOST || '');
  const user = String(settings.user || env.SSH_USER || '');
  const keyPath = settings.keyPath || env.SSH_KEY_PATH;
  const sshKey = env.SSH_KEY;
  const sshPort = Number(env.SSH_SSH_PORT || settings.sshPort) || 22;
  return { host, user, keyPath, sshKey, sshPort };
}

/**
 * @param {string} host
 * @param {string} user
 * @returns {string}
 */
export function formatRemoteDockerSshFailure(host, user) {
  return (
    `Could not reach ${host} via SSH as '${user}'. Check host,\n` +
    `username, and key path.`
  );
}

/**
 * @param {string} host
 * @param {string} user
 * @returns {string}
 */
export function formatRemoteDockerNotInstalled(host, user) {
  return (
    `Docker is not installed on the remote host (${user}@${host}).\n` +
    `Install Docker on the server first: https://docs.docker.com/engine/install/`
  );
}

/**
 * @param {string} host
 * @param {string} user
 * @returns {string}
 */
export function formatRemoteDockerPermissionDenied(host, user) {
  return (
    `SSH user '${user}' cannot access the Docker daemon on ${host}\n` +
    `(permission denied).\n` +
    `Run this on the remote server, then reconnect your SSH session:\n` +
    `sudo usermod -aG docker ${user}`
  );
}

/**
 * @param {string} host
 * @param {string} user
 * @returns {string}
 */
export function formatRemoteDockerDaemonOk(host, user) {
  return `Remote Docker daemon reachable (${user}@${host})`;
}

/**
 * @param {{ code?: number|null, stdout?: string, stderr?: string }} result
 * @returns {'ok'|'permission'|'not-installed'|'other'}
 */
export function classifyRemoteDockerPs(result) {
  const stdout = String(result?.stdout || '');
  const stderr = String(result?.stderr || '');
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  const code = result?.code;

  if (code === 0 || code === null) {
    return 'ok';
  }

  if (
    combined.includes('permission denied') ||
    combined.includes('got permission denied while trying to connect to the docker daemon')
  ) {
    return 'permission';
  }

  if (
    code === 127 ||
    combined.includes('command not found') ||
    /docker:\s*not found/.test(combined) ||
    (combined.includes('no such file or directory') && combined.includes('docker'))
  ) {
    return 'not-installed';
  }

  return 'other';
}

/**
 * Probe `docker ps` over the shared node-ssh session. Never throws — doctor
 * wraps each check independently.
 *
 * @param {{
 *   host: string,
 *   user: string,
 *   keyPath?: string,
 *   sshKey?: string,
 *   sshPort?: number,
 *   env?: Record<string, string|undefined>,
 * }} target
 * @returns {Promise<{
 *   sshOk: boolean,
 *   sshError?: string,
 *   kind?: ReturnType<typeof classifyRemoteDockerPs>,
 *   detail?: string,
 *   host: string,
 *   user: string,
 * }>}
 */
export async function probeRemoteDockerPs(target) {
  const host = target.host;
  const user = target.user;
  if (!host || !user) {
    return {
      sshOk: false,
      sshError: formatRemoteDockerSshFailure(host || '(missing host)', user || '(missing user)'),
      host: host || '',
      user: user || '',
    };
  }

  const session = createSshExecSession({
    host,
    user,
    keyPath: target.keyPath ? String(target.keyPath) : undefined,
    sshKey: target.sshKey,
    sshPort: target.sshPort,
    env: target.env,
  });

  /** @type {import('node-ssh').NodeSSH | undefined} */
  let ssh;
  try {
    ssh = await session.connect();
    const result = await session.execUnchecked(ssh, 'docker ps');
    const kind = classifyRemoteDockerPs(result);
    const detail = String(result.stderr || result.stdout || '').trim();
    return { sshOk: true, kind, detail, host, user };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      sshOk: false,
      sshError: formatRemoteDockerSshFailure(host, user),
      detail: msg,
      host,
      user,
    };
  } finally {
    if (ssh) ssh.dispose();
  }
}

/**
 * Quoted remote docker commands (image/container/env interpolated via shellQuote).
 * @param {string} imageRef
 * @param {string} containerName
 * @param {Record<string, string>} [runEnv]
 */
export function buildRemoteDockerCommands(imageRef, containerName, runEnv = {}) {
  const image = shellQuote(imageRef);
  const name = shellQuote(containerName);
  /** @type {string[]} */
  const envFlags = [];
  for (const [key, value] of Object.entries(runEnv)) {
    envFlags.push(`-e ${shellQuote(`${key}=${value}`)}`);
  }
  const envArg = envFlags.length > 0 ? `${envFlags.join(' ')} ` : '';

  return {
    stop: `docker stop ${name} 2>/dev/null || true`,
    rm: `docker rm -f ${name} 2>/dev/null || true`,
    pull: `docker pull ${image}`,
    run: `docker run -d --rm --name ${name} ${envArg}${image}`,
    ps: `docker ps --filter ${shellQuote(`name=^/${containerName}$`)} --format ${shellQuote('{{.Status}}')}`,
    info: 'docker info',
    /**
     * @param {string} registry
     * @param {string} username
     * @param {string} token
     */
    login: (registry, username, token) =>
      `echo ${shellQuote(token)} | docker login ${shellQuote(registry)} -u ${shellQuote(username)} --password-stdin`,
  };
}

export default {
  resolveDockerRemoteMode,
  resolveDockerSshTarget,
  probeRemoteDockerPs,
  buildRemoteDockerCommands,
};
