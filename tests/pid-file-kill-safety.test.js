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
      if (/\btest -f\b/.test(String(command))) {
        return { code: 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('PID-file kill safety (stale PID reused by unrelated process)', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;
  /** @type {string} */
  let keyPath;

  const config = {
    project: 'myapi',
    projectType: 'backend',
    framework: 'fastapi',
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
          port: 3000,
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
          port: 3001,
          keyPath: '',
        },
      },
    },
  };

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-pid-safe-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    keyPath = path.join(tmp, 'key');
    await fs.writeFile(keyPath, 'k');
    config.environments.staging.config.keyPath = keyPath;
    process.env.SSH_KEY = 'fake-key';
  });

  afterEach(async () => {
    delete process.env.SSH_KEY;
    await fs.remove(tmp);
  });

  test('stop sequence verifies /proc cmdline or environ for DEPLOYHUB_APP before kill', async () => {
    const provider = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await provider.deploy(artifactDir);

    const stopCmd = execCommands.find(
      (c) => c.includes('.deployhub.pid') && c.includes('kill')
    );
    expect(stopCmd).toBeTruthy();

    // Must gate kill on exact marker match — not blind kill "$(cat pidfile)"
    expect(stopCmd).toMatch(/\/proc\/\$pid\/cmdline|\/proc\/\$pid\/environ/);
    expect(stopCmd).toMatch(/grep -qxF 'DEPLOYHUB_APP=myapi-staging'/);
    expect(stopCmd).toMatch(/grep -qxF '-Ddeployhub\.app=myapi-staging'|grep -qxF 'deployhub\.app=myapi-staging'/);

    // The kill must appear AFTER the grep gate (inside the then-branch), not as
    // an unconditional `kill "$(cat …)"` the way the first revision did.
    expect(stopCmd).not.toMatch(
      /if \[ -f .*\]\]; then kill "\$\(cat/
    );
    const grepIdx = stopCmd.indexOf('grep -qxF');
    const killIdx = stopCmd.lastIndexOf('kill "$pid"');
    expect(grepIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(grepIdx);
  });

  test('unrelated process simulation: stop script does not emit blind kill on raw cat PID', async () => {
    // Evidence that a reused PID cannot be killed without matching our marker:
    // the remote script only reaches `kill "$pid"` after grep -qxF finds our
    // exact marker in that PID's /proc files. An unrelated process (e.g.
    // sshd, cron) has neither marker → kill branch is skipped; pidfile is still
    // removed so the next start writes a fresh PID.
    const provider = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await provider.deploy(artifactDir);
    const stopCmd = execCommands.find(
      (c) => c.includes('.deployhub.pid') && c.includes('/proc/$pid/')
    );
    expect(stopCmd).toContain('rm -f');
    // Structure: if grep matches → kill; always rm -f pidfile outside that gate
    expect(stopCmd).toMatch(
      /grep -qxF[\s\S]*kill "\$pid"[\s\S]*rm -f/
    );
  });

  test('orphan fallback also uses exact marker match (no blind pkill; PID-reuse safe)', async () => {
    const provider = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await provider.deploy(artifactDir);
    const orphanScan = execCommands.find(
      (c) => c.includes('/proc/[0-9]*') && c.includes('grep -qxF')
    );
    expect(orphanScan).toBeTruthy();
    expect(orphanScan).toMatch(/grep -qxF 'DEPLOYHUB_APP=myapi-staging'/);
    // Exact -x prevents DEPLOYHUB_APP=myapi matching myapi-staging
    expect(orphanScan).toMatch(/grep -qxF/);
    expect(execCommands.join('\n')).not.toMatch(/pkill -f 'DEPLOYHUB_APP=/);
  });

  test('Java / Go / .NET / Rails / Flask all use the same verify-then-kill stop helper', async () => {
    for (const framework of ['spring', 'go', 'dotnet', 'rails', 'flask']) {
      execCommands.length = 0;
      const cfg = {
        ...config,
        framework,
        environments: {
          ...config.environments,
          staging: {
            ...config.environments.staging,
            config: { ...config.environments.staging.config, keyPath },
          },
        },
      };
      const provider = createSshProvider(cfg, 'staging', { SSH_KEY: 'k' });
      await provider.deploy(artifactDir);
      const stopCmd = execCommands.find(
        (c) => c.includes('.deployhub.pid') && c.includes('grep -qxF')
      );
      expect(stopCmd).toBeTruthy();
      expect(stopCmd).toMatch(/\/proc\/\$pid\//);
      expect(stopCmd).not.toMatch(/if \[ -f .*\]\]; then kill "\$\(cat/);
    }
  });
});
