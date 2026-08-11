import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

/** @type {string[]} */
const execCommands = [];

/**
 * Simulate remote shell: nohup "starts", then the PID-liveness check fails
 * with app.log content (uvicorn crashed immediately).
 */
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

      // Post-start liveness probe (nohup + gunicorn --daemon share assertPidAliveAfterStart)
      if (cmd.includes('DEPLOYHUB_PROCESS_DIED') || cmd.includes('sleep 2')) {
        return {
          code: 1,
          stdout:
            'DEPLOYHUB_PROCESS_DIED: process exited immediately after start ' +
            "(pidfile='/var/www/myapi-dev/.deployhub.pid'). Last lines of '/var/www/myapi-dev/app.log':\n" +
            'ModuleNotFoundError: No module named application\n',
          stderr: '',
        };
      }

      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('startScopedNohup immediate-death detection', () => {
  jest.setTimeout(30000);

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

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-nohup-die-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    keyPath = path.join(tmp, 'key');
    await fs.writeFile(keyPath, '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n');
    config.environments.development.config.keyPath = keyPath;
  });

  afterEach(async () => {
    await fs.remove(tmp).catch(() => {});
  });

  test('FastAPI deploy fails loudly with app.log when process dies after nohup', async () => {
    const provider = createSshProvider(config, 'development');
    await expect(provider.deploy(artifactDir)).rejects.toThrow(
      /ModuleNotFoundError: No module named application/
    );

    const joined = execCommands.join('\n');
    expect(joined).toMatch(/nohup uvicorn main:app/);
    expect(joined).toMatch(/sleep 2/);
    expect(joined).toMatch(/DEPLOYHUB_PROCESS_DIED|\/proc\/\$pid/);
  });

  test('error message names the process, deploy path, and port (closure, not ReferenceError)', async () => {
    const provider = createSshProvider(config, 'development');
    let err;
    try {
      await provider.deploy(artifactDir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/died immediately after start/);
    expect(String(err.message)).toMatch(/myapi/);
    // `port` comes from createSshProvider closure (settings.port || config.port)
    expect(String(err.message)).toMatch(/port 8000/);
    expect(String(err.message)).not.toMatch(/ReferenceError|port undefined/);
  });

  test('Go deploy also runs the same post-nohup liveness check', async () => {
    execCommands.length = 0;
    const goConfig = {
      ...config,
      framework: 'go',
      environments: {
        development: {
          ...config.environments.development,
          config: { ...config.environments.development.config, keyPath },
        },
      },
    };
    const provider = createSshProvider(goConfig, 'development');
    await expect(provider.deploy(artifactDir)).rejects.toThrow(
      /died immediately after start|ModuleNotFoundError/
    );
    expect(execCommands.join('\n')).toMatch(/nohup \.\/bin\/app/);
    expect(execCommands.join('\n')).toMatch(/sleep 2/);
  });

  test('Flask gunicorn --daemon fails loudly with error log when master PID dies', async () => {
    execCommands.length = 0;
    const flaskConfig = {
      ...config,
      framework: 'flask',
      environments: {
        development: {
          ...config.environments.development,
          config: { ...config.environments.development.config, keyPath },
        },
      },
    };
    const provider = createSshProvider(flaskConfig, 'development');
    await expect(provider.deploy(artifactDir)).rejects.toThrow(
      /ModuleNotFoundError: No module named application/
    );
    const joined = execCommands.join('\n');
    expect(joined).toMatch(/gunicorn app:app/);
    expect(joined).toMatch(/--daemon/);
    expect(joined).toMatch(/--error-logfile/);
    expect(joined).toMatch(/--capture-output/);
    expect(joined).toMatch(/sleep 2/);
    expect(joined).toMatch(/DEPLOYHUB_PROCESS_DIED|\/proc\/\$pid/);
  });

  test('Django gunicorn --daemon runs the same settle-and-verify check', async () => {
    execCommands.length = 0;
    const djangoConfig = {
      ...config,
      framework: 'django',
      environments: {
        development: {
          ...config.environments.development,
          config: { ...config.environments.development.config, keyPath },
        },
      },
    };
    const provider = createSshProvider(djangoConfig, 'development');
    await expect(provider.deploy(artifactDir)).rejects.toThrow(
      /died immediately after start|ModuleNotFoundError/
    );
    const joined = execCommands.join('\n');
    expect(joined).toMatch(/gunicorn config\.wsgi:application/);
    expect(joined).toMatch(/--error-logfile/);
    expect(joined).toMatch(/sleep 2/);
  });
});
