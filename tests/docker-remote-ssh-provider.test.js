import { jest } from '@jest/globals';

const execCommands = [];
const mockExeca = jest.fn();

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async execCommand(command) {
      const cmd = String(command);
      execCommands.push(cmd);
      if (cmd.includes('docker inspect')) {
        return { code: 0, stdout: '0.0.0.0:80->', stderr: '' };
      }
      return { code: 0, stdout: 'Up 3 seconds', stderr: '' };
    }
    dispose() {}
  },
}));

jest.unstable_mockModule('execa', () => ({
  execa: mockExeca,
  default: mockExeca,
}));

jest.unstable_mockModule('../src/utils/docker-image-deploy.js', () => ({
  createDockerImageDeployContext: (_config, env) => ({
    fullImage: 'org/app:abc1234',
    getDockerEnv: () => {
      /** @type {Record<string, string>} */
      const dockerEnv = { ...process.env };
      if (env.DOCKER_HOST) dockerEnv.DOCKER_HOST = env.DOCKER_HOST;
      return dockerEnv;
    },
    ensureImageReadyForDeploy: async () => ({
      ranCompose: false,
      fullImage: 'org/app:abc1234',
    }),
    hasRegistryCredentials: () => false,
  }),
  checkImagePullability: async () => ({ ok: true, message: 'ok' }),
}));

const { createDockerProvider } = await import('../src/deployment/providers/docker.js');

function dockerConfig(envConfig) {
  return {
    project: 'myapp',
    projectType: 'frontend',
    environments: {
      production: {
        enabled: true,
        method: 'docker',
        trigger: 'manual',
        config: envConfig,
      },
    },
  };
}

describe('docker provider remote modes', () => {
  beforeEach(() => {
    execCommands.length = 0;
    mockExeca.mockReset();
    mockExeca.mockImplementation(async (cmd, args = []) => {
      if (cmd === 'docker' && args[0] === 'inspect') {
        return { stdout: '0.0.0.0:80->', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
  });

  test('local mode uses execa docker run, not node-ssh', async () => {
    const provider = createDockerProvider(
      dockerConfig({ remote: { mode: 'local' }, dockerImageName: 'org/app' }),
      'production',
      {}
    );
    await provider.deploy('/tmp/artifact');
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['run', '-d', '--rm', '--name', 'myapp', 'org/app:abc1234'],
      expect.any(Object)
    );
    expect(execCommands).toEqual([]);
  });

  test('local mode with port publishes -p and still does not use node-ssh', async () => {
    const provider = createDockerProvider(
      dockerConfig({ remote: { mode: 'local' }, dockerImageName: 'org/app', port: 80 }),
      'production',
      {}
    );
    await provider.deploy('/tmp/artifact');
    expect(mockExeca).toHaveBeenCalledWith(
      'docker',
      ['run', '-d', '--rm', '--name', 'myapp', '-p', '80:80', 'org/app:abc1234'],
      expect.any(Object)
    );
    expect(execCommands).toEqual([]);
  });

  test('raw mode still passes DOCKER_HOST to docker CLI', async () => {
    const provider = createDockerProvider(
      dockerConfig({
        remote: { mode: 'raw' },
        dockerHost: 'tcp://203.0.113.10:2376',
        dockerImageName: 'org/app',
      }),
      'production',
      {}
    );
    await provider.deploy('/tmp/artifact');
    const runCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'run'
    );
    expect(runCall).toBeDefined();
    expect(runCall[2].env.DOCKER_HOST).toBe('tcp://203.0.113.10:2376');
    expect(execCommands).toEqual([]);
  });

  test('raw mode with port publishes -p via docker CLI, not node-ssh', async () => {
    const provider = createDockerProvider(
      dockerConfig({
        remote: { mode: 'raw' },
        dockerHost: 'tcp://203.0.113.10:2376',
        dockerImageName: 'org/app',
        port: 80,
      }),
      'production',
      {}
    );
    await provider.deploy('/tmp/artifact');
    const runCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'run'
    );
    expect(runCall[1]).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'myapp',
      '-p',
      '80:80',
      'org/app:abc1234',
    ]);
    expect(runCall[2].env.DOCKER_HOST).toBe('tcp://203.0.113.10:2376');
    expect(execCommands).toEqual([]);
  });

  test('legacy DOCKER_HOST env without remote.mode is raw (CLI transport)', async () => {
    const provider = createDockerProvider(
      dockerConfig({ dockerImageName: 'org/app' }),
      'production',
      { DOCKER_HOST: 'ssh://ubuntu@203.0.113.10' }
    );
    await provider.deploy('/tmp/artifact');
    const runCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'docker' && c[1]?.[0] === 'run'
    );
    expect(runCall[2].env.DOCKER_HOST).toBe('ssh://ubuntu@203.0.113.10');
    expect(execCommands).toEqual([]);
  });

  test('ssh mode without SSH_HOST does not fall back to local docker run', async () => {
    const provider = createDockerProvider(
      dockerConfig({ remote: { mode: 'ssh' }, dockerImageName: 'org/app', port: 80 }),
      'production',
      { SSH_KEY: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n' }
    );
    expect(provider.remoteMode).toBe('ssh');
    await expect(provider.deploy('/tmp/artifact')).rejects.toThrow(
      /SSH host and user are required/
    );
    expect(mockExeca.mock.calls.some((c) => c[0] === 'docker' && c[1]?.[0] === 'run')).toBe(
      false
    );
    expect(execCommands).toEqual([]);
  });

  test('ssh mode without port fails loudly instead of running unpublished', async () => {
    const provider = createDockerProvider(
      dockerConfig({
        remote: { mode: 'ssh' },
        host: '203.0.113.10',
        user: 'ubuntu',
        dockerImageName: 'org/app',
      }),
      'production',
      { SSH_KEY: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n' }
    );
    await expect(provider.deploy('/tmp/artifact')).rejects.toThrow(
      /requires a published port/
    );
    expect(execCommands.some((c) => c.startsWith('docker run '))).toBe(false);
    expect(mockExeca.mock.calls.some((c) => c[0] === 'docker' && c[1]?.[0] === 'run')).toBe(
      false
    );
  });

  test('second ssh docker env without port does not inherit top-level port at deploy', async () => {
    const config = {
      project: 'myapp',
      port: 8000,
      defaultEnvironment: 'production',
      environments: {
        production: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: {
            remote: { mode: 'ssh' },
            host: '203.0.113.10',
            user: 'ubuntu',
            dockerImageName: 'org/app',
            port: 8000,
          },
        },
        staging: {
          enabled: true,
          method: 'docker',
          trigger: 'manual',
          config: {
            remote: { mode: 'ssh' },
            host: '203.0.113.11',
            user: 'ubuntu',
            dockerImageName: 'org/app',
          },
        },
      },
    };
    const provider = createDockerProvider(config, 'staging', {
      SSH_KEY: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n',
    });
    await expect(provider.deploy('/tmp/artifact')).rejects.toThrow(
      /requires a published port/
    );
    expect(execCommands.some((c) => c.startsWith('docker run '))).toBe(false);
  });

  test('ssh mode runs pull/run/stop/rm over node-ssh, not Docker CLI ssh://', async () => {
    const provider = createDockerProvider(
      dockerConfig({
        remote: { mode: 'ssh' },
        host: '203.0.113.10',
        user: 'ubuntu',
        dockerImageName: 'org/app',
        port: 80,
      }),
      'production',
      { SSH_KEY: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n' }
    );
    await provider.deploy('/tmp/artifact');
    expect(execCommands.some((c) => c.startsWith('docker pull '))).toBe(true);
    expect(execCommands.some((c) => c.includes(`docker run -d --rm --name 'myapp' -p '80:80'`))).toBe(
      true
    );
    expect(execCommands.some((c) => c.startsWith('docker stop '))).toBe(true);
    expect(execCommands.some((c) => c.startsWith('docker rm '))).toBe(true);
    expect(execCommands.some((c) => c.includes('docker inspect'))).toBe(true);
    expect(mockExeca.mock.calls.some((c) => c[0] === 'docker' && c[1]?.[0] === 'run')).toBe(
      false
    );
  });

  test('ssh mode runs preDeploy hooks before docker stop, postDeploy after inspect', async () => {
    const provider = createDockerProvider(
      dockerConfig({
        remote: { mode: 'ssh' },
        host: '203.0.113.10',
        user: 'ubuntu',
        dockerImageName: 'org/app',
        port: 80,
        hooks: {
          preDeploy: [{ command: 'echo PRE_HOOK' }],
          postDeploy: [{ command: 'echo POST_HOOK', continueOnError: true }],
        },
      }),
      'production',
      { SSH_KEY: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n' }
    );
    await provider.deploy('/tmp/artifact');
    const preIdx = execCommands.findIndex((c) => c === 'echo PRE_HOOK');
    const stopIdx = execCommands.findIndex((c) => c.startsWith('docker stop '));
    const inspectIdx = execCommands.findIndex((c) => c.includes('docker inspect'));
    const postIdx = execCommands.findIndex((c) => c === 'echo POST_HOOK');
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(preIdx);
    expect(postIdx).toBeGreaterThan(inspectIdx);
  });

  test('local mode with hooks configured fails instead of silently ignoring them', async () => {
    const provider = createDockerProvider(
      dockerConfig({
        remote: { mode: 'local' },
        dockerImageName: 'org/app',
        hooks: { preDeploy: [{ command: 'echo no' }] },
      }),
      'production',
      {}
    );
    await expect(provider.deploy('/tmp/artifact')).rejects.toThrow(/not supported/);
    expect(mockExeca.mock.calls.some((c) => c[0] === 'docker' && c[1]?.[0] === 'run')).toBe(
      false
    );
  });
});
