import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

/** @type {string[]} */
const execCommands = [];

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async putFile() {}
    async execCommand(command) {
      const cmd = String(command);
      execCommands.push(cmd);
      if (/\btest -f\b/.test(cmd)) {
        return { code: 1, stdout: '', stderr: '' };
      }
      // Let settle-verify succeed (process "stays alive")
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('SSH gunicorn honors startCommand app target', () => {
  jest.setTimeout(30000);

  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;
  /** @type {string} */
  let keyPath;

  /**
   * @param {string} framework
   * @param {string|null} startCommand
   */
  function makeConfig(framework, startCommand) {
    return {
      project: 'myapi',
      projectType: 'backend',
      framework,
      startCommand,
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
            keyPath: '',
          },
        },
      },
    };
  }

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-gunicorn-target-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    keyPath = path.join(tmp, 'key');
    await fs.writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n');
  });

  afterEach(async () => {
    await fs.remove(tmp).catch(() => {});
  });

  test('Django uses myapp.wsgi:application from startCommand, not config.wsgi', async () => {
    const config = makeConfig(
      'django',
      'gunicorn myapp.wsgi:application --bind 0.0.0.0:8000'
    );
    config.environments.development.config.keyPath = keyPath;
    const provider = createSshProvider(config, 'development');
    await provider.deploy(artifactDir);

    const gunicorn = execCommands.find((c) => c.includes('gunicorn'));
    expect(gunicorn).toBeTruthy();
    expect(gunicorn).toMatch(/gunicorn myapp\.wsgi:application/);
    expect(gunicorn).not.toMatch(/gunicorn config\.wsgi:application/);
  });

  test('Flask uses wsgi:app from startCommand, not hardcoded app:app', async () => {
    const config = makeConfig('flask', 'gunicorn wsgi:app --bind 0.0.0.0:5000');
    config.environments.development.config.keyPath = keyPath;
    config.port = 5000;
    config.environments.development.config.port = 5000;
    const provider = createSshProvider(config, 'development');
    await provider.deploy(artifactDir);

    const gunicorn = execCommands.find((c) => c.includes('gunicorn'));
    expect(gunicorn).toBeTruthy();
    expect(gunicorn).toMatch(/gunicorn wsgi:app/);
    expect(gunicorn).not.toMatch(/gunicorn app:app/);
  });

  test('Django without startCommand falls back to config.wsgi:application', async () => {
    const config = makeConfig('django', null);
    config.environments.development.config.keyPath = keyPath;
    const provider = createSshProvider(config, 'development');
    await provider.deploy(artifactDir);

    const gunicorn = execCommands.find((c) => c.includes('gunicorn'));
    expect(gunicorn).toMatch(/gunicorn config\.wsgi:application/);
  });
});
