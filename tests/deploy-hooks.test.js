/**
 * Shared deploy hooks: schema, doctor, SSH/docker-ssh execution, reject
 * unsupported methods. Real sshd evidence lives in deploy-hooks-real-sshd.test.js.
 */
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
      const cmd = String(command);
      execCommands.push(cmd);
      if (cmd.includes('HOOK_FAIL_NOW')) {
        return { code: 1, stdout: '', stderr: 'hook boom' };
      }
      if (cmd.includes('HOOK_HANG')) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ code: 0, stdout: 'late', stderr: '' }), 400);
        });
      }
      if (/\btest -f\b/.test(cmd)) {
        return { code: 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: cmd.includes('HOOK_OK') ? 'migrations ok' : 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

const {
  commandLooksSensitive,
  formatHookCommandForLog,
  getEnvHooks,
  envHasAnyHooks,
  hooksSupportedForMethod,
  assertHooksAllowed,
  runDeployHooks,
  getHooksDoctorChecks,
} = await import('../src/deployment/hooks.js');
const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
const { createDockerProvider } = await import('../src/deployment/providers/docker.js');
const { deployToAll, rollbackAll } = await import('../src/deployment/index.js');
const { loadConfig } = await import('../src/core/config.js');
const { METHOD_SETTINGS_ENV_OVERLAY } = await import('../src/core/environments.js');
const { buildServerEnvEntry } = await import('../src/deployment/init-prompts.js');

function sshConfig(hooks) {
  return {
    project: 'demo',
    projectType: 'frontend',
    framework: 'react',
    defaultEnvironment: 'production',
    environments: {
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: {
          host: '127.0.0.1',
          user: 'deploy',
          deployPath: '/home/deploy/app',
          keyPath: 'KEYPATH',
          sshPort: 22,
          ...(hooks ? { hooks } : {}),
        },
      },
    },
  };
}

describe('deploy hooks helpers', () => {
  test('commandLooksSensitive redacts password-like flags but not -p 22', () => {
    expect(commandLooksSensitive('mysql -p secret -e migrate')).toBe(true);
    expect(commandLooksSensitive('curl --password hunter2 https://x')).toBe(true);
    expect(commandLooksSensitive('TOKEN=abc123 ./notify.sh')).toBe(true);
    expect(commandLooksSensitive('ssh -p 22 user@host')).toBe(false);
    expect(commandLooksSensitive('docker exec myapp python manage.py migrate')).toBe(false);
    expect(formatHookCommandForLog('mysql -p secret')).toMatch(/withheld/);
    expect(formatHookCommandForLog('echo hi')).toBe('echo hi');
  });

  test('empty / missing hooks are a no-op', () => {
    expect(envHasAnyHooks({})).toBe(false);
    expect(envHasAnyHooks({ hooks: {} })).toBe(false);
    expect(getEnvHooks({}).preDeploy).toEqual([]);
  });

  test('hooksSupportedForMethod covers SSH-based + docker-ssh only', () => {
    expect(hooksSupportedForMethod('ssh', {})).toBe(true);
    expect(hooksSupportedForMethod('ec2', {})).toBe(true);
    expect(hooksSupportedForMethod('azure-vm', {})).toBe(true);
    expect(hooksSupportedForMethod('gcp-vm', {})).toBe(true);
    expect(hooksSupportedForMethod('docker', { remote: { mode: 'ssh' } })).toBe(true);
    expect(hooksSupportedForMethod('docker', { remote: { mode: 'local' } })).toBe(false);
    expect(hooksSupportedForMethod('docker', { remote: { mode: 'raw' } })).toBe(false);
    expect(hooksSupportedForMethod('kubernetes', {})).toBe(false);
  });

  test('assertHooksAllowed is a no-op when no hooks are set', () => {
    expect(() => assertHooksAllowed('kubernetes', {}, 'prod')).not.toThrow();
    expect(() =>
      assertHooksAllowed('docker', { remote: { mode: 'local' } }, 'prod')
    ).not.toThrow();
  });

  test('assertHooksAllowed rejects kubernetes and docker local/raw when hooks exist', () => {
    const hooks = { preDeploy: [{ command: 'echo x' }] };
    expect(() => assertHooksAllowed('kubernetes', { hooks }, 'prod')).toThrow(
      /not supported/
    );
    expect(() =>
      assertHooksAllowed('docker', { remote: { mode: 'local' }, hooks }, 'prod')
    ).toThrow(/remote\.mode "local"/);
    expect(() =>
      assertHooksAllowed('docker', { remote: { mode: 'raw' }, hooks }, 'prod')
    ).toThrow(/remote\.mode "raw"/);
  });

  test('METHOD_SETTINGS_ENV_OVERLAY does not copy hooks', () => {
    expect(METHOD_SETTINGS_ENV_OVERLAY.hooks).toBeUndefined();
  });

  test('kubernetes.js does not import the hook runner', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src/deployment/providers/kubernetes.js'),
      'utf8'
    );
    expect(src).not.toMatch(/hooks\.js/);
    expect(src).not.toMatch(/runDeployHooks/);
  });

  test('schema accepts per-env hooks', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-hooks-schema-'));
    const file = path.join(tmp, 'deployhub.config.json');
    await fs.writeJson(file, {
      project: 'demo',
      projectType: 'frontend',
      defaultEnvironment: 'production',
      environments: {
        production: {
          enabled: true,
          method: 'ssh',
          trigger: 'manual',
          config: {
            host: 'h',
            user: 'u',
            hooks: {
              preDeploy: [{ command: 'echo migrate', continueOnError: false, timeoutMs: 60000 }],
              postDeploy: [{ command: 'echo notify', continueOnError: true }],
            },
          },
        },
      },
      storage: ['local'],
    });
    const loaded = await loadConfig(tmp);
    expect(loaded.environments.production.config.hooks.preDeploy[0].command).toBe(
      'echo migrate'
    );
    await fs.remove(tmp);
  });

  test('doctor lists configured hooks as informational', () => {
    const checks = getHooksDoctorChecks(sshConfig({
      preDeploy: [{ command: 'a' }],
      postDeploy: [{ command: 'b' }],
      rollback: [{ command: 'c' }],
    }));
    expect(checks).toHaveLength(1);
    expect(checks[0].pass).toBe(true);
    expect(checks[0].name).toBe('Hooks (production)');
    expect(checks[0].message).toBe(
      "Hooks configured for 'production': 1 preDeploy, 1 postDeploy, 1 rollback"
    );
    expect(getHooksDoctorChecks(sshConfig(undefined))).toEqual([]);
  });

  test('buildServerEnvEntry stores hooks from prompt answers; --yes has none', () => {
    const withHooks = buildServerEnvEntry(
      {
        deployType: 'ssh',
        host: '1.2.3.4',
        user: 'ubuntu',
        keyPath: '/k',
        sshPort: 22,
        deployPath: '/var/www/app',
        hooks: {
          preDeploy: [{ command: 'docker exec myapp python manage.py migrate', continueOnError: false }],
        },
      },
      'frontend',
      'demo',
      null,
      null
    );
    expect(withHooks.config.hooks.preDeploy[0].command).toMatch(/migrate/);

    const noHooks = buildServerEnvEntry(
      {
        deployType: 'ssh',
        host: '1.2.3.4',
        user: 'ubuntu',
        keyPath: '/k',
        sshPort: 22,
        deployPath: '/var/www/app',
      },
      'frontend',
      'demo',
      null,
      null
    );
    expect(noHooks.config.hooks).toBeUndefined();
  });
});

describe('runDeployHooks on an existing session', () => {
  test('continueOnError false throws with hook-identified message', async () => {
    const session = {
      defaultExecTimeoutMs: 120000,
      execUnchecked: async () => ({ code: 1, stdout: '', stderr: 'nope' }),
    };
    await expect(
      runDeployHooks({
        session,
        ssh: {},
        settings: { hooks: { preDeploy: [{ command: 'false' }] } },
        stage: 'preDeploy',
      })
    ).rejects.toThrow(/preDeploy hook failed/);
  });

  test('continueOnError true logs and continues', async () => {
    const session = {
      defaultExecTimeoutMs: 120000,
      execUnchecked: async () => ({ code: 1, stdout: '', stderr: 'nope' }),
    };
    await expect(
      runDeployHooks({
        session,
        ssh: {},
        settings: {
          hooks: { postDeploy: [{ command: 'false', continueOnError: true }] },
        },
        stage: 'postDeploy',
      })
    ).resolves.toBeUndefined();
  });

  test('timeout is rewritten as hook timed out after Xms', async () => {
    const session = {
      defaultExecTimeoutMs: 120000,
      execUnchecked: async () => {
        throw new Error('SSH command timed out after 1500ms on deploy@host. Command: sleep 30');
      },
    };
    await expect(
      runDeployHooks({
        session,
        ssh: {},
        settings: {
          hooks: { preDeploy: [{ command: 'sleep 30', timeoutMs: 1500 }] },
        },
        stage: 'preDeploy',
      })
    ).rejects.toThrow(/preDeploy hook timed out after 1500ms/);
  });
});

describe('SSH provider hook integration (mocked node-ssh)', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;
  /** @type {string} */
  let keyPath;
  /** @type {ReturnType<typeof jest.spyOn>} */
  let logSpy;
  /** @type {string[]} */
  let logs;

  beforeEach(async () => {
    execCommands.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-hooks-ssh-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    keyPath = path.join(tmp, 'key');
    await fs.writeFile(
      keyPath,
      '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n'
    );
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await fs.remove(tmp).catch(() => {});
  });

  function provider(hooks) {
    const config = sshConfig(hooks);
    config.environments.production.config.keyPath = keyPath;
    return createSshProvider(config, 'production', { SSH_KEY: 'k' });
  }

  function text() {
    return logs.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  }

  test('preDeploy runs before unzip; postDeploy after extract', async () => {
    await provider({
      preDeploy: [{ command: 'echo HOOK_OK' }],
      postDeploy: [{ command: 'echo POST_OK', continueOnError: true }],
    }).deploy(artifactDir);

    const pre = execCommands.indexOf('echo HOOK_OK');
    const unzip = execCommands.findIndex((c) => c.includes('unzip -o'));
    const post = execCommands.indexOf('echo POST_OK');
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(unzip).toBeGreaterThan(pre);
    expect(post).toBeGreaterThan(unzip);
    expect(text()).toMatch(/\[hook:preDeploy].*\$ echo HOOK_OK/);
    expect(text()).toMatch(/\[hook:preDeploy].*migrations ok/);
  });

  test('failing preDeploy aborts before unzip', async () => {
    await expect(
      provider({
        preDeploy: [{ command: 'echo HOOK_FAIL_NOW' }],
      }).deploy(artifactDir)
    ).rejects.toThrow(/preDeploy hook failed/);
    expect(execCommands.some((c) => c.includes('unzip -o'))).toBe(false);
    expect(text()).toMatch(/\[hook:preDeploy]/);
  });

  test('failing postDeploy with continueOnError still succeeds', async () => {
    await expect(
      provider({
        postDeploy: [{ command: 'echo HOOK_FAIL_NOW', continueOnError: true }],
      }).deploy(artifactDir)
    ).resolves.toBeUndefined();
    expect(execCommands.some((c) => c.includes('unzip -o'))).toBe(true);
    expect(text()).toMatch(/postDeploy hook failed/);
  });

  test('hook timeoutMs fails loudly instead of hanging', async () => {
    const started = Date.now();
    await expect(
      provider({
        preDeploy: [{ command: 'echo HOOK_HANG', timeoutMs: 200 }],
      }).deploy(artifactDir)
    ).rejects.toThrow(/preDeploy hook timed out after 200ms/);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  test('rollback runs rollback hooks, not preDeploy', async () => {
    await provider({
      preDeploy: [{ command: 'echo PRE_SHOULD_NOT_RUN' }],
      rollback: [{ command: 'echo HOOK_OK' }],
      postDeploy: [{ command: 'echo POST_SHOULD_NOT_RUN' }],
    }).rollback(artifactDir, {});
    expect(execCommands).toContain('echo HOOK_OK');
    expect(execCommands).not.toContain('echo PRE_SHOULD_NOT_RUN');
    expect(execCommands).not.toContain('echo POST_SHOULD_NOT_RUN');
    expect(text()).toMatch(/\[hook:rollback]/);
  });

  test('preDeploy array short-circuits on continueOnError false', async () => {
    await expect(
      provider({
        preDeploy: [
          { command: 'echo HOOK_FAIL_NOW' },
          { command: 'echo HOOK_TWO_SHOULD_NOT_RUN' },
        ],
      }).deploy(artifactDir)
    ).rejects.toThrow(/preDeploy hook failed/);
    expect(execCommands).toContain('echo HOOK_FAIL_NOW');
    expect(execCommands).not.toContain('echo HOOK_TWO_SHOULD_NOT_RUN');
    expect(execCommands.some((c) => c.includes('unzip -o'))).toBe(false);
  });

  test('sensitive hook command is withheld from the $ log line', async () => {
    await provider({
      preDeploy: [{ command: 'echo HOOK_OK --password fake-secret-xyz' }],
    }).deploy(artifactDir);
    const out = text();
    expect(out).toMatch(/command withheld — possible credential in hook string/);
    expect(out).not.toMatch(/fake-secret-xyz/);
  });

  test('no hooks configured does not exec extra commands (regression)', async () => {
    await provider(undefined).deploy(artifactDir);
    expect(execCommands.some((c) => c.includes('HOOK'))).toBe(false);
    expect(text()).not.toMatch(/\[hook:/);
    expect(execCommands.some((c) => c.includes('unzip -o'))).toBe(true);
  });
});

describe('unsupported methods reject configured hooks', () => {
  test('deployToAll kubernetes with hooks throws before kubectl', async () => {
    await expect(
      deployToAll(
        {
          project: 'demo',
          projectType: 'backend',
          defaultEnvironment: 'production',
          environments: {
            production: {
              enabled: true,
              method: 'kubernetes',
              trigger: 'manual',
              config: {
                kubeNamespace: 'demo',
                hooks: { preDeploy: [{ command: 'echo no' }] },
              },
            },
          },
        },
        '/tmp/artifact',
        ['production']
      )
    ).rejects.toThrow(/Kubernetes deploys via kubectl/);
  });

  test('rollbackAll docker local with hooks throws', async () => {
    await expect(
      rollbackAll(
        {
          project: 'demo',
          projectType: 'backend',
          defaultEnvironment: 'production',
          environments: {
            production: {
              enabled: true,
              method: 'docker',
              trigger: 'manual',
              config: {
                remote: { mode: 'local' },
                hooks: { rollback: [{ command: 'echo no' }] },
              },
            },
          },
        },
        '/tmp/artifact',
        ['production'],
        { buildId: '1.0.0-abc' }
      )
    ).rejects.toThrow(/not supported/);
  });

  test('createDockerProvider local deploy with hooks does not start a container', async () => {
    const provider = createDockerProvider(
      {
        project: 'demo',
        projectType: 'frontend',
        environments: {
          production: {
            enabled: true,
            method: 'docker',
            trigger: 'manual',
            config: {
              remote: { mode: 'local' },
              dockerImageName: 'demo',
              hooks: { preDeploy: [{ command: 'echo no' }] },
            },
          },
        },
      },
      'production',
      {}
    );
    await expect(provider.deploy('/tmp/artifact')).rejects.toThrow(/not supported/);
  });
});
