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
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('orphaned env-only backend process cleanup', () => {
  jest.setTimeout(30000);

  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;
  /** @type {string} */
  let keyPath;

  /**
   * @param {string} framework
   */
  function makeConfig(framework) {
    return {
      project: 'myapi',
      projectType: 'backend',
      framework,
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
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-orphan-'));
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
    await fs.remove(tmp).catch(() => {});
  });

  test('stop scans /proc/*/environ for exact DEPLOYHUB_APP (not pkill -f cmdline-only)', async () => {
    const config = makeConfig('fastapi');
    config.environments.development.config.keyPath = keyPath;
    const provider = createSshProvider(config, 'development');
    await provider.deploy(artifactDir);

    const orphanScan = execCommands.find(
      (c) => c.includes('/proc/[0-9]*') && c.includes('environ') && c.includes('kill')
    );
    expect(orphanScan).toBeTruthy();
    // Exact match — env-only orphans from VAR=value nohup are visible here
    expect(orphanScan).toMatch(/grep -qxF 'DEPLOYHUB_APP=myapi'/);
    expect(orphanScan).toMatch(/\/proc\/\[0-9\]\*/);
    // Old broken fallback must be gone
    expect(execCommands.join('\n')).not.toMatch(/pkill -f 'DEPLOYHUB_APP=/);
  });

  test('start embeds DEPLOYHUB_APP in argv0 via bash exec -a (cmdline-visible)', async () => {
    const config = makeConfig('fastapi');
    config.environments.development.config.keyPath = keyPath;
    const provider = createSshProvider(config, 'development');
    await provider.deploy(artifactDir);

    const start = execCommands.find((c) => c.includes('nohup') && c.includes('uvicorn'));
    expect(start).toBeTruthy();
    expect(start).toMatch(/exec -a/);
    expect(start).toMatch(/DEPLOYHUB_APP='myapi'|DEPLOYHUB_APP=myapi/);
    expect(start).toMatch(/<\/dev\/null/);
    // Brace-group prevents `cd && nohup ... &` from backgrounding the AND-list
    // (that precedence bug hangs real SSH while the app still starts).
    expect(start).toMatch(/cd .+ && \{[\s\S]*nohup[\s\S]*& echo \$!/);
    expect(start).not.toMatch(/cd .+ && DEPLOYHUB_APP=.+ nohup .+ <\/dev\/null & echo/);
  });

  test('FastAPI / Go / Java / .NET / Rails start commands all use brace-grouped nohup', async () => {
    for (const framework of ['fastapi', 'go', 'spring', 'dotnet', 'rails']) {
      execCommands.length = 0;
      const config = makeConfig(framework);
      config.environments.development.config.keyPath = keyPath;
      const provider = createSshProvider(config, 'development');
      await provider.deploy(artifactDir);

      const start = execCommands.find(
        (c) => c.includes('nohup') && c.includes('DEPLOYHUB_APP')
      );
      expect(start).toBeTruthy();
      expect(start).toMatch(/cd .+ && \{[\s\S]*nohup[\s\S]*& echo \$!/);
      expect(start).toMatch(/exec -a/);
    }
  });

  test('FastAPI / Go / Java / .NET / Rails / Flask all use environ orphan scan', async () => {
    for (const framework of ['fastapi', 'go', 'spring', 'dotnet', 'rails', 'flask']) {
      execCommands.length = 0;
      const config = makeConfig(framework);
      config.environments.development.config.keyPath = keyPath;
      if (framework === 'flask') {
        config.port = 5000;
        config.environments.development.config.port = 5000;
      }
      const provider = createSshProvider(config, 'development');
      await provider.deploy(artifactDir);

      const orphanScan = execCommands.find(
        (c) => c.includes('/proc/[0-9]*') && c.includes('grep -qxF')
      );
      expect(orphanScan).toBeTruthy();
      expect(orphanScan).toMatch(/DEPLOYHUB_APP=myapi|deployhub\.app=myapi/);
      expect(execCommands.join('\n')).not.toMatch(/pkill -f 'DEPLOYHUB_APP=/);
    }
  });
});
