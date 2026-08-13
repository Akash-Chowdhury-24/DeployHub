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
      const cmd = String(command);
      if (/\btest -f\b/.test(cmd)) {
        return { code: 1, stdout: '', stderr: '' };
      }
      // PHP-FPM unit discovery (Debian/Ubuntu-style versioned unit)
      if (/list-unit-files/.test(cmd) && /php/.test(cmd)) {
        return { code: 0, stdout: 'php8.4-fpm.service\tenabled\n', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

/**
 * Multi-env same-host backend configs — one grandfathered, one prefixed.
 * Asserts each language's remote start sequence uses env-scoped process
 * identity (PID file + DEPLOYHUB_APP / deployhub.app marker) and NEVER the
 * old host-wide pkill patterns that would kill the sibling environment.
 */
describe('backend language process isolation (multi-env same host)', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;
  /** @type {string} */
  let keyPath;

  function baseConfig(framework) {
    return {
      project: 'myapi',
      projectType: 'backend',
      framework,
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
  }

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-lang-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    keyPath = path.join(tmp, 'key');
    await fs.writeFile(keyPath, 'k');
    process.env.SSH_KEY = 'fake-key';
  });

  afterEach(async () => {
    delete process.env.SSH_KEY;
    await fs.remove(tmp);
  });

  /**
   * @param {string} framework
   * @param {(joined: string, envName: string) => void} assertEnv
   */
  async function deployBothEnvs(framework, assertEnv) {
    const config = baseConfig(framework);
    config.environments.development.config.keyPath = keyPath;
    config.environments.staging.config.keyPath = keyPath;

    execCommands.length = 0;
    const dev = createSshProvider(config, 'development', { SSH_KEY: 'k' });
    await dev.deploy(artifactDir);
    const devJoined = execCommands.join('\n');
    assertEnv(devJoined, 'development');

    // Must never use host-wide kill patterns
    expect(devJoined).not.toMatch(/(?:^|\n)pkill uvicorn(?:\s|$)/);
    expect(devJoined).not.toMatch(/(?:^|\n)pkill gunicorn(?:\s|$)/);
    expect(devJoined).not.toMatch(/pkill -f "\*\.jar"/);
    expect(devJoined).not.toMatch(/pkill -f "dotnet"/);
    expect(devJoined).not.toMatch(/(?:^|\n)pkill puma(?:\s|$)/);

    execCommands.length = 0;
    const staging = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await staging.deploy(artifactDir);
    const stagingJoined = execCommands.join('\n');
    assertEnv(stagingJoined, 'staging');

    expect(stagingJoined).not.toMatch(/(?:^|\n)pkill uvicorn(?:\s|$)/);
    expect(stagingJoined).not.toMatch(/(?:^|\n)pkill gunicorn(?:\s|$)/);
    expect(stagingJoined).not.toMatch(/pkill -f "\*\.jar"/);
    expect(stagingJoined).not.toMatch(/pkill -f "dotnet"/);
    expect(stagingJoined).not.toMatch(/(?:^|\n)pkill puma(?:\s|$)/);

    // Scoped markers must differ across envs
    expect(devJoined).toMatch(/DEPLOYHUB_APP='myapi'|deployhub\.app=myapi/);
    expect(stagingJoined).toMatch(
      /DEPLOYHUB_APP='myapi-staging'|deployhub\.app=myapi-staging/
    );
  }

  test('Python FastAPI: scoped PID + DEPLOYHUB_APP, no host-wide pkill uvicorn', async () => {
    await deployBothEnvs('fastapi', (joined, envName) => {
      expect(joined).toMatch(/\.deployhub\.pid/);
      expect(joined).toMatch(/uvicorn main:app/);
      expect(joined).toMatch(
        envName === 'development'
          ? /DEPLOYHUB_APP='myapi'/
          : /DEPLOYHUB_APP='myapi-staging'/
      );
    });
  });

  test('Python Flask: scoped gunicorn --pid, no host-wide pkill gunicorn', async () => {
    await deployBothEnvs('flask', (joined, envName) => {
      expect(joined).toMatch(/gunicorn app:app/);
      expect(joined).toMatch(/--pid/);
      expect(joined).toMatch(/\.deployhub\.pid/);
      expect(joined).toMatch(
        envName === 'development'
          ? /DEPLOYHUB_APP='myapi'/
          : /DEPLOYHUB_APP='myapi-staging'/
      );
    });
  });

  test('Java Spring: scoped -Ddeployhub.app + PID, no pkill -f "*.jar"', async () => {
    await deployBothEnvs('spring', (joined, envName) => {
      expect(joined).toMatch(/java -Ddeployhub\.app=/);
      expect(joined).toMatch(/\.deployhub\.pid/);
      expect(joined).toMatch(
        envName === 'development'
          ? /deployhub\.app=myapi/
          : /deployhub\.app=myapi-staging/
      );
    });
  });

  test('Go: scoped PID + DEPLOYHUB_APP around ./bin/app, no bare pkill appName', async () => {
    await deployBothEnvs('go', (joined, envName) => {
      expect(joined).toMatch(/\.\/bin\/app/);
      expect(joined).toMatch(/\.deployhub\.pid/);
      // Must not use the old broken `pkill myapi` (never matched ./bin/app)
      expect(joined).not.toMatch(/pkill 'myapi'(?:\s|$)/);
      expect(joined).toMatch(
        envName === 'development'
          ? /DEPLOYHUB_APP='myapi'/
          : /DEPLOYHUB_APP='myapi-staging'/
      );
    });
  });

  test('.NET: scoped PID + DEPLOYHUB_APP, no pkill -f "dotnet"', async () => {
    await deployBothEnvs('dotnet', (joined, envName) => {
      expect(joined).toMatch(/dotnet App\.dll/);
      expect(joined).toMatch(/\.deployhub\.pid/);
      expect(joined).toMatch(
        envName === 'development'
          ? /DEPLOYHUB_APP='myapi'/
          : /DEPLOYHUB_APP='myapi-staging'/
      );
    });
  });

  test('Rails: scoped PID + DEPLOYHUB_APP around puma, no host-wide pkill puma', async () => {
    await deployBothEnvs('rails', (joined, envName) => {
      expect(joined).toMatch(/bundle exec puma/);
      expect(joined).toMatch(/\.deployhub\.pid/);
      expect(joined).toMatch(
        envName === 'development'
          ? /DEPLOYHUB_APP='myapi'/
          : /DEPLOYHUB_APP='myapi-staging'/
      );
    });
  });

  test('PHP Laravel: no unscoped process kill; uses php-fpm service reload', async () => {
    const config = baseConfig('laravel');
    config.environments.development.config.keyPath = keyPath;
    config.environments.staging.config.keyPath = keyPath;

    const staging = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await staging.deploy(artifactDir);
    const joined = execCommands.join('\n');
    expect(joined).toMatch(/composer install/);
    expect(joined).toMatch(/php artisan migrate/);
    expect(joined).toMatch(/list-unit-files/);
    expect(joined).toMatch(/systemctl restart ['"]?php8\.4-fpm['"]?/);
    expect(joined).not.toMatch(/systemctl restart php8\.2-fpm/);
    expect(joined).not.toMatch(/pkill/);
  });

  test('Python FastAPI rollback reissues scoped start (restored artifact → running process)', async () => {
    const config = baseConfig('fastapi');
    config.environments.staging.config.keyPath = keyPath;

    execCommands.length = 0;
    const provider = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await provider.rollback(artifactDir, {
      buildId: '1.0.0-old',
      semver: '1.0.0',
      remoteKey: 'myapi/builds/1.0.0-old/artifact.zip',
    });

    const joined = execCommands.join('\n');
    expect(joined).toMatch(/unzip -o/);
    expect(joined).toMatch(/pip install -r requirements\.txt/);
    expect(joined).toMatch(/\.deployhub\.pid/);
    expect(joined).toMatch(/DEPLOYHUB_APP='myapi-staging'/);
    expect(joined).toMatch(/uvicorn main:app/);
    expect(joined).not.toMatch(/(?:^|\n)pkill uvicorn(?:\s|$)/);
  });
});
