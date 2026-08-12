/**
 * Independent gcp-vm evidence — must NOT rely on azure-vm inference.
 * Exercises real createGcpVmProvider → mocked gcloud resolveHost → real
 * createSshProvider deploy with env-scoped PM2 names.
 */
import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const sshExecCommands = [];
const gcloudCalls = [];

jest.unstable_mockModule('node-ssh', () => ({
  NodeSSH: class {
    async connect() {
      return this;
    }
    async putFile() {}
    async execCommand(command) {
      sshExecCommands.push(command);
      if (/\btest -f\b/.test(String(command))) {
        return { code: 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    }
    dispose() {}
  },
}));

jest.unstable_mockModule('execa', () => ({
  execa: async (cmd, args = []) => {
    if (cmd === 'gcloud') {
      gcloudCalls.push(['gcloud', ...args]);
      return { stdout: '34.100.200.50\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  },
  default: async (cmd, args = []) => {
    if (cmd === 'gcloud') {
      gcloudCalls.push(['gcloud', ...args]);
      return { stdout: '34.100.200.50\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  },
}));

const { createGcpVmProvider } = await import(
  '../src/deployment/providers/gcp-vm.js'
);

describe('EVIDENCE gcp-vm: independent host-resolution + PM2 scoping', () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let artifactDir;
  /** @type {string} */
  let keyPath;

  beforeEach(async () => {
    sshExecCommands.length = 0;
    gcloudCalls.length = 0;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-gcp-ev-'));
    artifactDir = path.join(tmp, 'artifact');
    await fs.ensureDir(artifactDir);
    await fs.writeFile(path.join(artifactDir, 'artifact.zip'), 'fake-zip');
    keyPath = path.join(tmp, 'key');
    await fs.writeFile(keyPath, 'k');
    process.env.SSH_KEY = 'k';
  });

  afterEach(async () => {
    delete process.env.SSH_KEY;
    await fs.remove(tmp);
  });

  test('gcp-vm resolveHost via gcloud then deploys with scoped PM2 name (staging)', async () => {
    const config = {
      project: 'demoapp',
      projectType: 'backend',
      framework: 'express',
      port: 3000,
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments: {
        development: {
          enabled: true,
          method: 'gcp-vm',
          trigger: 'push',
          config: {
            user: 'ubuntu',
            deployPath: '/var/www/demoapp',
            appName: 'demoapp',
            keyPath,
            gcpProjectId: 'my-gcp-proj',
            gcpZone: 'us-central1-a',
            gcpInstanceName: 'demoapp-dev',
            // host intentionally omitted — forces gcloud lookup
          },
        },
        staging: {
          enabled: true,
          method: 'gcp-vm',
          trigger: 'manual',
          config: {
            user: 'ubuntu',
            deployPath: '/var/www/demoapp-staging',
            appName: 'demoapp',
            keyPath,
            gcpProjectId: 'my-gcp-proj',
            gcpZone: 'us-central1-a',
            gcpInstanceName: 'demoapp-staging',
          },
        },
      },
    };

    // No SSH_HOST in env — must call gcloud
    const provider = createGcpVmProvider(config, 'staging', {
      SSH_KEY: 'k',
      SSH_USER: 'ubuntu',
      GCP_VM_LOOKUP_PROJECT_ID: 'my-gcp-proj',
      GCP_ZONE: 'us-central1-a',
      GCP_INSTANCE_NAME: 'demoapp-staging',
    });

    await provider.deploy(artifactDir);

    // Proof: GCP-specific resolveHost path ran (not azure/ec2, not pre-set host)
    expect(gcloudCalls.length).toBeGreaterThanOrEqual(1);
    expect(gcloudCalls[0][0]).toBe('gcloud');
    expect(gcloudCalls[0]).toEqual(
      expect.arrayContaining([
        'compute',
        'instances',
        'describe',
        'demoapp-staging',
        '--zone',
        'us-central1-a',
        '--project',
        'my-gcp-proj',
      ])
    );

    const joined = sshExecCommands.join('\n');
    // Resolved IP from mocked gcloud is used by SSH provider (logged in connect path
    // via host closure). Deploy sequence must use staging-scoped PM2 name.
    expect(joined).toMatch(
      /pm2 restart 'demoapp-staging'|pm2 start npm --name 'demoapp-staging'/
    );
    expect(joined).not.toMatch(
      /pm2 restart 'demoapp'(?:\s|$)|--name 'demoapp' -- start/
    );
    expect(joined).toMatch(/unzip -o/);
    expect(joined).toMatch(/npm install --production/);
    expect(joined).toMatch(/pm2 save/);
  });

  test('gcp-vm rollback after gcloud resolveHost reissues scoped PM2 restart', async () => {
    const config = {
      project: 'demoapp',
      projectType: 'backend',
      framework: 'express',
      defaultEnvironment: 'development',
      unprefixedSecretEnvironment: 'development',
      environments: {
        development: {
          enabled: true,
          method: 'gcp-vm',
          trigger: 'push',
          config: {
            user: 'ubuntu',
            deployPath: '/var/www/demoapp',
            appName: 'demoapp',
            keyPath,
          },
        },
        staging: {
          enabled: true,
          method: 'gcp-vm',
          trigger: 'manual',
          config: {
            user: 'ubuntu',
            deployPath: '/var/www/demoapp-staging',
            appName: 'demoapp',
            keyPath,
          },
        },
      },
    };

    sshExecCommands.length = 0;
    gcloudCalls.length = 0;

    const provider = createGcpVmProvider(config, 'staging', {
      SSH_KEY: 'k',
      SSH_USER: 'ubuntu',
      GCP_VM_LOOKUP_PROJECT_ID: 'proj',
      GCP_ZONE: 'europe-west1-b',
      GCP_INSTANCE_NAME: 'staging-vm',
    });

    await provider.rollback(artifactDir, { buildId: '1.0.0-old' });

    expect(gcloudCalls.some((c) => c[0] === 'gcloud')).toBe(true);
    const joined = sshExecCommands.join('\n');
    expect(joined).toMatch(/pm2 restart 'demoapp-staging'|pm2 start npm --name 'demoapp-staging'/);
    expect(joined).toMatch(/unzip -o/);
  });
});
