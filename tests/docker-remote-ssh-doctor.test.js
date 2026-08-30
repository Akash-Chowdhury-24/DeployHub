import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const sshReachability = jest.fn();
const sshKeyDoctor = jest.fn();

/** @type {{ failConnect: boolean, ps: { code: number, stdout: string, stderr: string } }} */
const sshRemote = {
  failConnect: false,
  ps: { code: 0, stdout: 'CONTAINER ID', stderr: '' },
};

jest.unstable_mockModule('../src/deployment/init-helpers.js', () => ({
  testSshConnectivity: jest.fn(),
  validateSshKeyForDoctor: (...args) => sshKeyDoctor(...args),
  testSshHostReachability: (...args) => sshReachability(...args),
}));

jest.unstable_mockModule('../src/utils/docker-image-deploy.js', () => ({
  checkImagePullability: jest.fn(),
  createDockerImageDeployContext: jest.fn(),
}));

jest.unstable_mockModule('../src/deployment/index.js', () => ({
  getDeploymentProvider: jest.fn(),
}));

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      if (sshRemote.failConnect) {
        throw new Error('All configured authentication methods failed');
      }
      return this;
    }
    async execCommand() {
      return sshRemote.ps;
    }
    dispose() {}
  },
}));

const { runDeploymentChecks } = await import('../src/commands/doctor.js');
const {
  formatRemoteDockerSshFailure,
  formatRemoteDockerNotInstalled,
  formatRemoteDockerPermissionDenied,
  formatRemoteDockerDaemonOk,
} = await import('../src/utils/docker-remote.js');

describe('doctor docker remote.mode ssh', () => {
  const prevEnv = { ...process.env };
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let keyPath;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-docker-ssh-doc-'));
    keyPath = path.join(tmp, 'key.pem');
    await fs.writeFile(
      keyPath,
      '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n',
      { mode: 0o600 }
    );
    sshRemote.failConnect = false;
    sshRemote.ps = { code: 0, stdout: 'CONTAINER ID', stderr: '' };
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
    sshReachability.mockReset();
    sshKeyDoctor.mockReset();
    await fs.remove(tmp).catch(() => {});
  });

  function sshDockerConfig(user = 'ubuntu') {
    return {
      project: 'demo',
      projectType: 'frontend',
      environments: {
        production: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: {
            remote: { mode: 'ssh' },
            host: '203.0.113.10',
            user,
            dockerImageName: 'org/app',
          },
        },
      },
    };
  }

  test('all four ssh docker checks pass independently', async () => {
    process.env.DOCKER_IMAGE_NAME = 'org/app';
    process.env.SSH_HOST = '203.0.113.10';
    process.env.SSH_USER = 'ubuntu';
    process.env.SSH_KEY_PATH = keyPath;
    sshKeyDoctor.mockResolvedValue({ ok: true, message: `SSH key file valid (${keyPath})` });
    sshReachability.mockResolvedValue({
      ok: true,
      message: 'TCP connection to 203.0.113.10:22 succeeded',
    });

    const config = sshDockerConfig();
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const names = checks.map((c) => c.name);
    expect(names).toContain('SSH key');
    expect(names).toContain('SSH host reachability');
    expect(names).toContain('Remote Docker daemon reachable');
    expect(names).toContain('Remote Docker permission');
    expect(names).not.toContain('Docker daemon');

    const daemon = checks.find((c) => c.name === 'Remote Docker daemon reachable');
    const perm = checks.find((c) => c.name === 'Remote Docker permission');
    expect(daemon?.pass).toBe(true);
    expect(daemon?.message).toBe(formatRemoteDockerDaemonOk('203.0.113.10', 'ubuntu'));
    expect(perm?.pass).toBe(true);
  });

  test('wrong key path uses shared SSH key check message', async () => {
    process.env.DOCKER_IMAGE_NAME = 'org/app';
    process.env.SSH_HOST = '203.0.113.10';
    process.env.SSH_USER = 'ubuntu';
    process.env.SSH_KEY_PATH = '/no/such/key.pem';
    sshKeyDoctor.mockResolvedValue({
      ok: false,
      message:
        'SSH key file not found at /no/such/key.pem — check SSH_KEY_PATH points to your private .pem/.key file.',
    });
    sshReachability.mockResolvedValue({ ok: true, message: 'ok' });

    const config = sshDockerConfig();
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const key = checks.find((c) => c.name === 'SSH key');
    expect(key?.pass).toBe(false);
    expect(key?.message).toMatch(/SSH key file not found/);
    expect(checks.find((c) => c.name === 'SSH host reachability')?.pass).toBe(true);
  });

  test('SSH connect failure uses SSH-level copy, not Docker install copy', async () => {
    process.env.DOCKER_IMAGE_NAME = 'org/app';
    process.env.SSH_HOST = '203.0.113.10';
    process.env.SSH_USER = 'baduser';
    process.env.SSH_KEY_PATH = keyPath;
    sshKeyDoctor.mockResolvedValue({ ok: true, message: 'key ok' });
    sshReachability.mockResolvedValue({ ok: true, message: 'tcp ok' });
    sshRemote.failConnect = true;

    const config = sshDockerConfig('baduser');
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const daemon = checks.find((c) => c.name === 'Remote Docker daemon reachable');
    const perm = checks.find((c) => c.name === 'Remote Docker permission');
    expect(daemon?.pass).toBe(false);
    expect(daemon?.message).toBe(formatRemoteDockerSshFailure('203.0.113.10', 'baduser'));
    expect(perm?.message).toBe(formatRemoteDockerSshFailure('203.0.113.10', 'baduser'));
    expect(daemon?.message).not.toMatch(/Docker is not installed/);
  });

  test('missing docker group uses exact permission copy; daemon check still reports', async () => {
    process.env.DOCKER_IMAGE_NAME = 'org/app';
    process.env.SSH_HOST = '203.0.113.10';
    process.env.SSH_USER = 'ubuntu';
    process.env.SSH_KEY_PATH = keyPath;
    sshKeyDoctor.mockResolvedValue({ ok: true, message: 'key ok' });
    sshReachability.mockResolvedValue({ ok: true, message: 'tcp ok' });
    sshRemote.ps = {
      code: 1,
      stdout: '',
      stderr:
        'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
    };

    const config = sshDockerConfig();
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const daemon = checks.find((c) => c.name === 'Remote Docker daemon reachable');
    const perm = checks.find((c) => c.name === 'Remote Docker permission');
    expect(daemon?.pass).toBe(true);
    expect(daemon?.message).toBe(formatRemoteDockerDaemonOk('203.0.113.10', 'ubuntu'));
    expect(perm?.pass).toBe(false);
    expect(perm?.message).toBe(formatRemoteDockerPermissionDenied('203.0.113.10', 'ubuntu'));
  });

  test('docker not installed uses exact install copy', async () => {
    process.env.DOCKER_IMAGE_NAME = 'org/app';
    process.env.SSH_HOST = '203.0.113.10';
    process.env.SSH_USER = 'ubuntu';
    process.env.SSH_KEY_PATH = keyPath;
    sshKeyDoctor.mockResolvedValue({ ok: true, message: 'key ok' });
    sshReachability.mockResolvedValue({ ok: true, message: 'tcp ok' });
    sshRemote.ps = { code: 127, stdout: '', stderr: 'bash: docker: command not found' };

    const config = sshDockerConfig();
    const checks = await runDeploymentChecks(config, 'production', config.environments.production);
    const daemon = checks.find((c) => c.name === 'Remote Docker daemon reachable');
    expect(daemon?.pass).toBe(false);
    expect(daemon?.message).toBe(formatRemoteDockerNotInstalled('203.0.113.10', 'ubuntu'));
  });
});
