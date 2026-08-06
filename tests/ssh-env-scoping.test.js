import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const execCommands = [];

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async putFile() {}
    async execCommand(command) {
      execCommands.push(command);
      return { code: 0, stdout: '', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('E1 — SSH per-env deployPath scoping on rollback', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-ssh-scope-'));
    const artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake');
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('rollback on production uses production deployPath, not testing', async () => {
    const config = {
      project: 'myapp',
      projectType: 'backend',
      framework: 'express',
      startCommand: 'npm start',
      environments: {
        testing: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: {
            host: '10.0.0.1',
            user: 'deploy',
            deployPath: '/var/www/testing-path',
          },
        },
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: {
            host: '10.0.0.2',
            user: 'deploy',
            deployPath: '/var/www/production-path',
          },
        },
      },
    };

    const artifactDir = path.join(tmp, 'artifact');
    const prod = createSshProvider(config, 'production', { SSH_KEY: 'fake-key' });
    await prod.rollback(artifactDir, { buildId: '1.0.0-old' });

    expect(execCommands.some((c) => c.includes('/var/www/production-path'))).toBe(true);
    expect(execCommands.some((c) => c.includes('/var/www/testing-path'))).toBe(false);

    execCommands.length = 0;
    const test = createSshProvider(config, 'testing', { SSH_KEY: 'fake-key' });
    await test.rollback(artifactDir, { buildId: '1.0.0-old' });

    expect(execCommands.some((c) => c.includes('/var/www/testing-path'))).toBe(true);
    expect(execCommands.some((c) => c.includes('/var/www/production-path'))).toBe(false);
  });
});

describe('E2 — nginx site file naming', () => {
  test('grandfathered env keeps project-only site path', async () => {
    const { resolveNginxSiteName, getNginxSitesAvailablePath } = await import(
      '../src/utils/nginx.js'
    );
    const config = {
      project: 'my-shared-project',
      defaultEnvironment: 'production',
      unprefixedSecretEnvironment: 'production',
      environments: {
        production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
        staging: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };
    expect(getNginxSitesAvailablePath(resolveNginxSiteName(config, 'production'))).toBe(
      '/etc/nginx/sites-available/my-shared-project'
    );
    expect(getNginxSitesAvailablePath(resolveNginxSiteName(config, 'staging'))).toBe(
      '/etc/nginx/sites-available/my-shared-project-staging'
    );
  });
});
