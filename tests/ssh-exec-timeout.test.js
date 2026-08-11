import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async putFile() {}
    async execCommand(command) {
      const cmd = String(command);
      // Simulate a stuck remote start (SSH channel never completes)
      if (cmd.includes('nohup') || cmd.includes('DEPLOYHUB_APP')) {
        return new Promise(() => {
          /* never resolves */
        });
      }
      if (/\btest -f\b/.test(cmd)) {
        return { code: 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('SSH exec timeout (no silent hang)', () => {
  jest.setTimeout(15000);

  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;
  /** @type {string} */
  let keyPath;
  /** @type {string | undefined} */
  let prevTimeout;
  /** @type {string | undefined} */
  let prevStartTimeout;

  beforeEach(async () => {
    prevTimeout = process.env.DEPLOYHUB_SSH_EXEC_TIMEOUT_MS;
    prevStartTimeout = process.env.DEPLOYHUB_SSH_START_TIMEOUT_MS;
    process.env.DEPLOYHUB_SSH_EXEC_TIMEOUT_MS = '200';
    process.env.DEPLOYHUB_SSH_START_TIMEOUT_MS = '200';

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-ssh-timeout-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    keyPath = path.join(tmp, 'key');
    await fs.writeFile(
      keyPath,
      '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n'
    );
  });

  afterEach(async () => {
    if (prevTimeout === undefined) delete process.env.DEPLOYHUB_SSH_EXEC_TIMEOUT_MS;
    else process.env.DEPLOYHUB_SSH_EXEC_TIMEOUT_MS = prevTimeout;
    if (prevStartTimeout === undefined) delete process.env.DEPLOYHUB_SSH_START_TIMEOUT_MS;
    else process.env.DEPLOYHUB_SSH_START_TIMEOUT_MS = prevStartTimeout;
    await fs.remove(tmp).catch(() => {});
  });

  test('hung nohup/start SSH exec fails loudly within timeout instead of hanging', async () => {
    const config = {
      project: 'myapi',
      projectType: 'backend',
      framework: 'fastapi',
      port: 8000,
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments: {
        development: {
          enabled: true,
          method: 'ssh',
          trigger: 'push',
          config: {
            host: '10.0.0.1',
            user: 'ubuntu',
            deployPath: '/var/www/myapi-dev',
            appName: 'myapi',
            port: 8000,
            keyPath,
          },
        },
      },
    };

    // Provider reads timeout env at create time
    const provider = createSshProvider(config, 'development', {
      ...process.env,
      DEPLOYHUB_SSH_EXEC_TIMEOUT_MS: '200',
      DEPLOYHUB_SSH_START_TIMEOUT_MS: '200',
      SSH_KEY: undefined,
    });

    const started = Date.now();
    await expect(provider.deploy(artifactDir)).rejects.toThrow(/timed out after 200ms/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
