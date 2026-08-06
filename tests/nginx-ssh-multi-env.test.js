import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const execCommands = [];
/** @type {'debian' | 'rhel'} */
let mockNginxLayout = 'debian';

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async putFile() {}
    async execCommand(command) {
      execCommands.push(command);
      if (command.includes('command -v') && command.includes('nginx')) {
        return { code: 0, stdout: 'yes', stderr: '' };
      }
      if (command.includes('test -f') && command.includes('nginx.conf')) {
        return { code: 0, stdout: 'yes', stderr: '' };
      }
      if (command.includes('test -d') && command.includes('/etc/nginx/sites-available')) {
        return mockNginxLayout === 'debian'
          ? { code: 0, stdout: 'yes', stderr: '' }
          : { code: 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    dispose() {}
  },
}));

const { createSshProvider } = await import('../src/deployment/providers/ssh.js');

describe('nginx activation paths per environment (same host)', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    execCommands.length = 0;
    mockNginxLayout = 'debian';
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-nginx-multi-'));
    const artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake');
    await fs.writeFile(path.join(artifactDir, 'nginx.conf'), 'server {}');
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  const config = {
    project: 'myapp',
    projectType: 'frontend',
    framework: 'react',
    defaultEnvironment: 'production',
    unprefixedSecretEnvironment: 'production',
    environments: {
      staging: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { host: '10.0.0.1', user: 'deploy', deployPath: '/var/www/staging' },
      },
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { host: '10.0.0.1', user: 'deploy', deployPath: '/var/www/production' },
      },
    },
  };

  test('debian layout: staging and production activate different sites-available paths', async () => {
    const artifactDir = path.join(tmp, 'artifact');
    const staging = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await staging.deploy(artifactDir);

    expect(execCommands.some((c) => c.includes('sites-available/myapp-staging'))).toBe(true);
    expect(execCommands.some((c) => c.includes('sites-enabled/myapp-staging'))).toBe(true);
    expect(
      execCommands.some(
        (c) => c.includes('sites-available/myapp') && !c.includes('myapp-staging')
      )
    ).toBe(false);

    execCommands.length = 0;
    const production = createSshProvider(config, 'production', { SSH_KEY: 'k' });
    await production.deploy(artifactDir);

    expect(
      execCommands.some(
        (c) => c.includes('sites-available/myapp') && !c.includes('myapp-staging')
      )
    ).toBe(true);
    expect(
      execCommands.some(
        (c) => c.includes('sites-enabled/myapp') && !c.includes('myapp-staging')
      )
    ).toBe(true);
    expect(execCommands.some((c) => c.includes('sites-available/myapp-staging'))).toBe(false);
  });

  test('rhel layout: non-grandfathered env uses conf.d/{project}-{env}.conf', async () => {
    mockNginxLayout = 'rhel';
    execCommands.length = 0;
    const artifactDir = path.join(tmp, 'artifact');

    const provider = createSshProvider(config, 'staging', { SSH_KEY: 'k' });
    await provider.deploy(artifactDir);

    expect(execCommands.some((c) => c.includes('/etc/nginx/conf.d/myapp-staging.conf'))).toBe(
      true
    );
    expect(
      execCommands.some(
        (c) => c.includes('/etc/nginx/conf.d/myapp.conf') && !c.includes('staging')
      )
    ).toBe(false);
  });
});
