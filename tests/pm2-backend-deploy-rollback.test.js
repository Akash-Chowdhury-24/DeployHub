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
      // nginx.conf probe — not present for backend
      if (/\btest -f\b/.test(String(command))) {
        return { code: 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('backend PM2 deploy + rollback restart sequence', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;

  const baseConfig = {
    project: 'myapi',
    projectType: 'backend',
    framework: 'express',
    port: 3000,
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
          keyPath: '',
        },
      },
      staging: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: {
          host: '10.0.0.1',
          user: 'ubuntu',
          deployPath: '/var/www/myapi-staging',
          appName: 'myapi',
          keyPath: '',
        },
      },
    },
  };

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-pm2-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    // Provide key via env so connect() works
    process.env.SSH_KEY = 'fake-key';
  });

  afterEach(async () => {
    delete process.env.SSH_KEY;
    await fs.remove(tmp);
  });

  test('deploy to development and staging uses distinct PM2 names on same host', async () => {
    const keyPath = path.join(tmp, 'key');
    await fs.writeFile(keyPath, 'k');
    baseConfig.environments.development.config.keyPath = keyPath;
    baseConfig.environments.staging.config.keyPath = keyPath;

    const dev = createSshProvider(baseConfig, 'development', { SSH_KEY: 'k' });
    await dev.deploy(artifactDir);
    const staging = createSshProvider(baseConfig, 'staging', { SSH_KEY: 'k' });
    await staging.deploy(artifactDir);

    const pm2Lines = execCommands.filter((c) => /\bpm2\b/.test(c));
    expect(pm2Lines.some((c) => c.includes("--name 'myapi'") || c.includes('restart myapi') || c.includes("restart 'myapi'"))).toBe(true);
    expect(
      pm2Lines.some(
        (c) =>
          c.includes('myapi-staging') ||
          c.includes("--name 'myapi-staging'") ||
          c.includes("restart 'myapi-staging'")
      )
    ).toBe(true);
    // Must not restart the same process name for both
    const restartTargets = pm2Lines
      .filter((c) => /pm2 restart/.test(c))
      .map((c) => c);
    expect(restartTargets.length).toBeGreaterThanOrEqual(2);
    expect(restartTargets[0]).not.toEqual(restartTargets[1]);
  });

  test('backend rollback runs extract → npm install → pm2 restart/start → pm2 save', async () => {
    const keyPath = path.join(tmp, 'key');
    await fs.writeFile(keyPath, 'k');
    baseConfig.environments.development.config.keyPath = keyPath;

    execCommands.length = 0;
    const provider = createSshProvider(baseConfig, 'development', { SSH_KEY: 'k' });
    await provider.rollback(artifactDir, {
      buildId: '1.0.0-abc',
      semver: '1.0.0',
      remoteKey: 'myapi/builds/1.0.0-abc/artifact.zip',
    });

    const joined = execCommands.join('\n');
    expect(joined).toMatch(/unzip -o/);
    expect(joined).toMatch(/npm install --production/);
    expect(joined).toMatch(/pm2 restart/);
    expect(joined).toMatch(/pm2 start/);
    expect(joined).toMatch(/pm2 save/);
    // Grandfathered name
    expect(joined).toMatch(/myapi/);
  });
});
