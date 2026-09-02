import { NodeSSH } from 'node-ssh';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { formatRemoteCommandFailure } from '../utils/shell-quote.js';

/**
 * Shared node-ssh connection + exec wrapper used by ssh.js and docker
 * `remote.mode === "ssh"`. Do not duplicate this layer in providers.
 *
 * @param {{
 *   host?: string,
 *   user?: string,
 *   keyPath?: string,
 *   sshKey?: string,
 *   sshPort?: number,
 *   env?: Record<string, string|undefined>,
 *   log?: { info: Function, error: Function },
 * }} opts
 */
export function createSshExecSession(opts) {
  const env = opts.env || process.env;
  const host = opts.host;
  const user = opts.user;
  const sshKey = opts.sshKey || env.SSH_KEY;
  const keyPath = opts.keyPath;
  const sshPort = Number(opts.sshPort) || 22;
  const log = opts.log || { info() {}, error() {} };

  // Defense-in-depth: never let a stuck SSH channel hang CI indefinitely.
  // Override with DEPLOYHUB_SSH_EXEC_TIMEOUT_MS (ms).
  const defaultExecTimeoutMs = Number(env.DEPLOYHUB_SSH_EXEC_TIMEOUT_MS) || 120_000;

  async function connect() {
    if (!host || !user) {
      throw new Error(
        'SSH host and user are required. Set SSH_HOST and SSH_USER in .env (see .env.example comments).'
      );
    }

    if (!sshKey && !keyPath) {
      throw new Error(
        'SSH authentication required. Set SSH_KEY_PATH (local) or SSH_KEY (CI secret) in .env — see .env.example.'
      );
    }

    const ssh = new NodeSSH();
    /** @type {import('node-ssh').SSHConnectOptions} */
    const connectOpts = { host, username: user, port: sshPort };

    if (sshKey) {
      const tmpKeyPath = path.join(
        os.tmpdir(),
        `deployhub-ssh-key-${process.pid}-${Date.now()}`
      );
      await fs.writeFile(tmpKeyPath, sshKey, { mode: 0o600 });
      connectOpts.privateKeyPath = tmpKeyPath;
    } else if (keyPath) {
      const expanded = keyPath.replace(/^~/, os.homedir());
      connectOpts.privateKeyPath = path.resolve(expanded);
    }

    try {
      await ssh.connect(connectOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `SSH connection failed to ${user}@${host}:${sshPort} — ${msg}. Check SSH_HOST, SSH_USER, SSH_KEY_PATH, and that port ${sshPort} is open in your firewall/security group.`
      );
    }
    return ssh;
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} command
   * @param {{ timeoutMs?: number, logCommand?: boolean }} [execOpts]
   */
  async function runCommand(ssh, command, execOpts = {}) {
    const timeoutMs = execOpts.timeoutMs ?? defaultExecTimeoutMs;
    if (execOpts.logCommand !== false) {
      log.info(`$ ${command}`);
    }

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `SSH command timed out after ${timeoutMs}ms on ${user}@${host}. ` +
              `The remote command may still be running — check the server. ` +
              `Command: ${command.length > 240 ? `${command.slice(0, 240)}…` : command}`
          )
        );
      }, timeoutMs);
    });

    let result;
    try {
      result = await Promise.race([ssh.execCommand(command), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return result;
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} command
   * @param {{ timeoutMs?: number, logCommand?: boolean }} [execOpts]
   */
  async function exec(ssh, command, execOpts = {}) {
    const result = await runCommand(ssh, command, execOpts);
    if (result.code !== 0 && result.code !== null) {
      const message = formatRemoteCommandFailure(
        command,
        result.code,
        result.stderr,
        result.stdout
      );
      log.error(message);
      throw new Error(message);
    }
    return result;
  }

  /**
   * Same timeout wrapper as exec(), but does not throw on non-zero exit.
   * Used by doctor so a failed remote probe is classified, not a crash.
   *
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} command
   * @param {{ timeoutMs?: number, logCommand?: boolean }} [execOpts]
   */
  async function execUnchecked(ssh, command, execOpts = {}) {
    return runCommand(ssh, command, execOpts);
  }

  return {
    connect,
    exec,
    execUnchecked,
    host,
    user,
    sshPort,
    defaultExecTimeoutMs,
  };
}

export default { createSshExecSession };
