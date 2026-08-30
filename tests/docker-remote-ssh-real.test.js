/**
 * Real Ubuntu sshd + Docker daemon: remote.mode ssh pull/run over node-ssh,
 * doctor success and failure paths, raw/local daemon regression.
 *
 * Requires Docker (privileged DinD). describe.skip when Docker is unavailable.
 */
import { jest } from '@jest/globals';
import { execa } from 'execa';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createSshExecSession } from '../src/deployment/ssh-connection.js';
import { buildRemoteDockerCommands } from '../src/utils/docker-remote.js';
import { createDockerProvider } from '../src/deployment/providers/docker.js';
import { runDeploymentChecks } from '../src/commands/doctor.js';
import {
  formatRemoteDockerSshFailure,
  formatRemoteDockerPermissionDenied,
  formatRemoteDockerDaemonOk,
} from '../src/utils/docker-remote.js';

const CONTAINER = 'deployhub-test-docker-ssh';
const IMAGE = 'deployhub-test-docker-ssh:ubuntu';
const SSH_PORT = 2224;

/** @returns {Promise<boolean>} */
async function dockerAvailable() {
  try {
    await execa('docker', ['info'], { timeout: 20000 });
    return true;
  } catch (err) {
    console.warn(
      'Docker unavailable — skipping real remote-ssh docker tests:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

const HAS_DOCKER = await dockerAvailable();
const describeReal = HAS_DOCKER ? describe : describe.skip;

/**
 * @param {string} tmp
 */
async function ensureSshdDocker(tmp) {
  const key = path.join(tmp, 'id_ed25519');
  if (!(await fs.pathExists(key))) {
    await execa('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '']);
  }
  const pub = (await fs.readFile(`${key}.pub`, 'utf8')).trim() + '\n';
  await fs.writeFile(path.join(tmp, 'authorized_keys'), pub);

  const dockerfile = `
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      openssh-server docker.io ca-certificates iptables \\
 && mkdir -p /var/run/sshd \\
 && (id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu) \\
 && useradd -m -s /bin/bash noperm \\
 && mkdir -p /home/ubuntu/.ssh /home/noperm/.ssh \\
 && chmod 700 /home/ubuntu/.ssh /home/noperm/.ssh \\
 && usermod -aG docker ubuntu \\
 && ssh-keygen -A \\
 && rm -rf /var/lib/apt/lists/*
COPY authorized_keys /home/ubuntu/.ssh/authorized_keys
COPY authorized_keys /home/noperm/.ssh/authorized_keys
RUN chown -R ubuntu:ubuntu /home/ubuntu \\
 && chown -R noperm:noperm /home/noperm \\
 && chmod 600 /home/ubuntu/.ssh/authorized_keys /home/noperm/.ssh/authorized_keys \\
 && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \\
 && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
`.trim();

  const startSh = `#!/bin/bash
set -e
dockerd --storage-driver=vfs >/var/log/dockerd.log 2>&1 &
for i in $(seq 1 40); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
exec /usr/sbin/sshd -D -e
`;

  await fs.writeFile(path.join(tmp, 'Dockerfile'), dockerfile);
  await fs.writeFile(path.join(tmp, 'start.sh'), startSh.replace(/\r\n/g, '\n'));
  await execa('docker', ['rm', '-f', CONTAINER], { reject: false });
  await execa('docker', ['build', '-t', IMAGE, tmp], { timeout: 360000 });
  await execa('docker', [
    'run',
    '-d',
    '--privileged',
    '--name',
    CONTAINER,
    '-p',
    `${SSH_PORT}:22`,
    IMAGE,
  ]);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const session = createSshExecSession({
        host: '127.0.0.1',
        user: 'ubuntu',
        keyPath: key,
        sshPort: SSH_PORT,
      });
      const ssh = await session.connect();
      try {
        const r = await session.execUnchecked(ssh, 'docker info >/dev/null && echo docker-ready');
        if (String(r.stdout || '').includes('docker-ready')) {
          ssh.dispose();
          return key;
        }
      } finally {
        ssh.dispose();
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('Timed out waiting for sshd+dockerd in test container');
}

describeReal('remote Docker via SSH (real Ubuntu sshd + dockerd)', () => {
  jest.setTimeout(420000);

  /** @type {string} */
  let tmp;
  /** @type {string} */
  let keyPath;
  const prevEnv = { ...process.env };

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-docker-ssh-real-'));
    keyPath = await ensureSshdDocker(tmp);
    await execa('docker', ['pull', 'hello-world'], { timeout: 120000 });
  });

  afterAll(async () => {
    await execa('docker', ['rm', '-f', CONTAINER], { reject: false });
    await fs.remove(tmp).catch(() => {});
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
  });

  function sshConfig(user = 'ubuntu') {
    return {
      project: 'hello-world',
      projectType: 'frontend',
      environments: {
        production: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: {
            remote: { mode: 'ssh' },
            host: '127.0.0.1',
            user,
            dockerImageName: 'hello-world',
            sshPort: SSH_PORT,
          },
        },
      },
    };
  }

  test('real node-ssh docker pull + docker run on Ubuntu', async () => {
    const session = createSshExecSession({
      host: '127.0.0.1',
      user: 'ubuntu',
      keyPath,
      sshPort: SSH_PORT,
    });
    const ssh = await session.connect();
    try {
      const cmds = buildRemoteDockerCommands('hello-world', 'dh-ssh-proof');
      await session.exec(ssh, cmds.rm);
      const pull = await session.exec(ssh, cmds.pull, { timeoutMs: 120000 });
      const run = await session.exec(ssh, 'docker run --rm --name dh-ssh-proof hello-world');
      expect(`${pull.stdout}\n${run.stdout}`).toMatch(/Hello from Docker|Pulled|Downloaded|hello-world/i);
      console.log('--- remote docker pull stdout ---\n', pull.stdout);
      console.log('--- remote docker run stdout ---\n', run.stdout);
    } finally {
      ssh.dispose();
    }
  });

  test('createDockerProvider ssh mode pull/run over the same connection', async () => {
    const config = sshConfig();
    const provider = createDockerProvider(config, 'production', {
      SSH_KEY_PATH: keyPath,
      SSH_SSH_PORT: String(SSH_PORT),
      DOCKER_IMAGE_NAME: 'hello-world',
      DOCKER_IMAGE_TAG: 'latest',
    });
    await provider.deploy(tmp);
    expect(provider.remoteMode).toBe('ssh');
  });

  test('SSH + docker ps succeed, docker pull of a missing image surfaces remote stderr', async () => {
    const missing = 'deployhub-no-such-image-zzz:test';
    await execa('docker', ['tag', 'hello-world:latest', missing]);

    const session = createSshExecSession({
      host: '127.0.0.1',
      user: 'ubuntu',
      keyPath,
      sshPort: SSH_PORT,
    });
    const ssh = await session.connect();
    try {
      const ps = await session.exec(ssh, 'docker ps');
      expect(ps.code).toBe(0);
    } finally {
      ssh.dispose();
    }

    const config = {
      project: 'hello-world',
      projectType: 'frontend',
      environments: {
        production: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: {
            remote: { mode: 'ssh' },
            host: '127.0.0.1',
            user: 'ubuntu',
            dockerImageName: 'deployhub-no-such-image-zzz',
            sshPort: SSH_PORT,
          },
        },
      },
    };
    const provider = createDockerProvider(config, 'production', {
      SSH_KEY_PATH: keyPath,
      SSH_SSH_PORT: String(SSH_PORT),
      DOCKER_IMAGE_NAME: 'deployhub-no-such-image-zzz',
      DOCKER_IMAGE_TAG: 'test',
    });

    let thrown;
    try {
      await provider.deploy(tmp);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    console.log('--- remote docker pull failure ---\n', msg);
    expect(msg).toMatch(/Deploy failed: docker exited with code /);
    expect(msg).toMatch(
      /pull access denied|repository does not exist|manifest unknown|not found/i
    );
    expect(msg).not.toMatch(/SSH command failed/i);
  });

  test('doctor passes SSH key, host, remote daemon, and docker permission', async () => {
    process.env.DOCKER_IMAGE_NAME = 'hello-world';
    process.env.SSH_HOST = '127.0.0.1';
    process.env.SSH_USER = 'ubuntu';
    process.env.SSH_KEY_PATH = keyPath;
    process.env.SSH_SSH_PORT = String(SSH_PORT);

    const config = sshConfig();
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName['SSH key']?.pass).toBe(true);
    expect(byName['SSH host reachability']?.pass).toBe(true);
    expect(byName['Remote Docker daemon reachable']?.pass).toBe(true);
    expect(byName['Remote Docker daemon reachable']?.message).toBe(
      formatRemoteDockerDaemonOk('127.0.0.1', 'ubuntu')
    );
    expect(byName['Remote Docker permission']?.pass).toBe(true);
    console.log(
      checks
        .map((c) => `  ${c.pass ? '✓' : '✗'} ${c.name}: ${c.message}`)
        .join('\n')
    );
  });

  test('doctor: wrong key path is actionable, not a stack trace', async () => {
    process.env.DOCKER_IMAGE_NAME = 'hello-world';
    process.env.SSH_HOST = '127.0.0.1';
    process.env.SSH_USER = 'ubuntu';
    process.env.SSH_KEY_PATH = path.join(tmp, 'no-such-key.pem');
    process.env.SSH_SSH_PORT = String(SSH_PORT);

    const config = sshConfig();
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const key = checks.find((c) => c.name === 'SSH key');
    expect(key?.pass).toBe(false);
    expect(key?.message).toMatch(/SSH key file not found/);
    expect(key?.message).not.toMatch(/at Object\./);
  });

  test('doctor: wrong user is SSH-level copy, not Docker install copy', async () => {
    process.env.DOCKER_IMAGE_NAME = 'hello-world';
    process.env.SSH_HOST = '127.0.0.1';
    process.env.SSH_USER = 'wronguser';
    process.env.SSH_KEY_PATH = keyPath;
    process.env.SSH_SSH_PORT = String(SSH_PORT);

    const config = sshConfig('wronguser');
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const daemon = checks.find((c) => c.name === 'Remote Docker daemon reachable');
    expect(daemon?.pass).toBe(false);
    expect(daemon?.message).toBe(formatRemoteDockerSshFailure('127.0.0.1', 'wronguser'));
    expect(daemon?.message).not.toMatch(/Docker is not installed/);
  });

  test('doctor: user not in docker group gets exact permission copy', async () => {
    process.env.DOCKER_IMAGE_NAME = 'hello-world';
    process.env.SSH_HOST = '127.0.0.1';
    process.env.SSH_USER = 'noperm';
    process.env.SSH_KEY_PATH = keyPath;
    process.env.SSH_SSH_PORT = String(SSH_PORT);

    const config = sshConfig('noperm');
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const daemon = checks.find((c) => c.name === 'Remote Docker daemon reachable');
    const perm = checks.find((c) => c.name === 'Remote Docker permission');
    expect(daemon?.pass).toBe(true);
    expect(daemon?.message).toBe(formatRemoteDockerDaemonOk('127.0.0.1', 'noperm'));
    expect(perm?.pass).toBe(false);
    expect(perm?.message).toBe(formatRemoteDockerPermissionDenied('127.0.0.1', 'noperm'));
  });

  test('raw/local mode still talks to the host Docker daemon (regression)', async () => {
    const localProvider = createDockerProvider(
      {
        project: 'hello-world',
        environments: {
          production: {
            method: 'docker',
            config: { remote: { mode: 'local' }, dockerImageName: 'hello-world' },
          },
        },
      },
      'production',
      { DOCKER_IMAGE_NAME: 'hello-world', DOCKER_IMAGE_TAG: 'latest' }
    );
    await localProvider.testConnection();
    expect(localProvider.remoteMode).toBe('local');

    const rawProvider = createDockerProvider(
      {
        project: 'hello-world',
        environments: {
          production: {
            method: 'docker',
            config: { remote: { mode: 'raw' }, dockerImageName: 'hello-world' },
          },
        },
      },
      'production',
      { DOCKER_IMAGE_NAME: 'hello-world', DOCKER_IMAGE_TAG: 'latest' }
    );
    await rawProvider.testConnection();
    expect(rawProvider.remoteMode).toBe('raw');

    const inferredHost =
      process.platform === 'win32'
        ? 'npipe:////./pipe/docker_engine'
        : 'unix:///var/run/docker.sock';
    const inferred = createDockerProvider(
      {
        project: 'hello-world',
        environments: {
          production: {
            method: 'docker',
            config: { dockerImageName: 'hello-world' },
          },
        },
      },
      'production',
      { DOCKER_IMAGE_NAME: 'hello-world', DOCKER_HOST: inferredHost }
    );
    expect(inferred.remoteMode).toBe('raw');
    await inferred.testConnection();
  });
});
