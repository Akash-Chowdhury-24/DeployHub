/**
 * Real Ubuntu sshd evidence for custom deploy hooks (preDeploy / postDeploy /
 * rollback). Port 2225 so this does not collide with nohup (2223) or docker-ssh (2224).
 *
 * Requires Docker. describe.skip when Docker is unavailable.
 */
import { jest } from '@jest/globals';
import { execa } from 'execa';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import { NodeSSH } from 'node-ssh';

const CONTAINER = 'deployhub-test-sshd-hooks';
const IMAGE = 'deployhub-test-sshd-hooks:ubuntu';
const SSH_PORT = 2225;
const DEPLOY_PATH = '/home/deploy/app';

/** @returns {Promise<boolean>} */
async function dockerAvailable() {
  try {
    await execa('docker', ['ps', '-q'], { timeout: 20000 });
    return true;
  } catch (err) {
    console.warn(
      'Docker unavailable — skipping real-sshd hook tests:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

const HAS_DOCKER = await dockerAvailable();
const describeRealSsh = HAS_DOCKER ? describe : describe.skip;

/**
 * @param {string} sourceDir
 * @param {string} zipPath
 */
function createZip(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * @param {string} tmp
 * @returns {Promise<string>}
 */
async function ensureSshd(tmp) {
  const key = path.join(tmp, 'id_ed25519');
  if (!(await fs.pathExists(key))) {
    await execa('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '']);
  }
  const pub = (await fs.readFile(`${key}.pub`, 'utf8')).trim() + '\n';
  await fs.writeFile(path.join(tmp, 'authorized_keys'), pub);

  const dockerfile = `
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      openssh-server util-linux bash unzip \\
 && mkdir -p /var/run/sshd \\
 && useradd -m -s /bin/bash deploy \\
 && mkdir -p /home/deploy/.ssh /home/deploy/app \\
 && chmod 700 /home/deploy/.ssh \\
 && ssh-keygen -A \\
 && rm -rf /var/lib/apt/lists/*
COPY authorized_keys /home/deploy/.ssh/authorized_keys
RUN chown -R deploy:deploy /home/deploy \\
 && chmod 600 /home/deploy/.ssh/authorized_keys \\
 && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \\
 && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd","-D","-e"]
`.trim();

  await fs.writeFile(path.join(tmp, 'Dockerfile'), dockerfile);
  await execa('docker', ['rm', '-f', CONTAINER], { reject: false });
  await execa('docker', ['build', '-t', IMAGE, tmp], { timeout: 300000 });
  await execa('docker', [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `${SSH_PORT}:22`,
    IMAGE,
  ]);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const ssh = new NodeSSH();
      await ssh.connect({
        host: '127.0.0.1',
        port: SSH_PORT,
        username: 'deploy',
        privateKeyPath: key,
      });
      await ssh.execCommand('echo ready');
      ssh.dispose();
      return key;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('sshd container did not accept SSH within 30s');
}

/**
 * @param {string} label
 * @returns {Promise<{ artifactDir: string }>}
 */
async function makeArtifact(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-hooks-art-'));
  const staging = path.join(dir, 'src');
  await fs.ensureDir(staging);
  await fs.writeFile(path.join(staging, 'index.html'), `<p>${label}</p>\n`);
  await createZip(staging, path.join(dir, 'artifact.zip'));
  await fs.remove(staging);
  return { artifactDir: dir };
}

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '');
}

describeRealSsh('custom deploy hooks real SSH (Docker sshd)', () => {
  jest.setTimeout(300000);

  /** @type {string} */
  let tmp;
  /** @type {string} */
  let keyPath;
  /** @type {ReturnType<typeof jest.spyOn>} */
  let logSpy;
  /** @type {string[]} */
  let logs;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-hooks-sshd-'));
    keyPath = await ensureSshd(tmp);
  });

  afterAll(async () => {
    await execa('docker', ['rm', '-f', CONTAINER], { reject: false });
    await fs.remove(tmp).catch(() => {});
  });

  beforeEach(() => {
    logs = [];
    const originalLog = console.log.bind(console);
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
      originalLog(...args);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function text() {
    return stripAnsi(logs.join('\n'));
  }

  function config(hooks) {
    return {
      project: 'hooks-demo',
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
            deployPath: DEPLOY_PATH,
            keyPath,
            sshPort: SSH_PORT,
            ...(hooks ? { hooks } : {}),
          },
        },
      },
    };
  }

  async function remote(cmd) {
    const ssh = new NodeSSH();
    await ssh.connect({
      host: '127.0.0.1',
      port: SSH_PORT,
      username: 'deploy',
      privateKeyPath: keyPath,
    });
    try {
      return await ssh.execCommand(cmd);
    } finally {
      ssh.dispose();
    }
  }

  test('1. preDeploy succeeds before extract; logs command and hook output', async () => {
    await remote(`rm -rf ${DEPLOY_PATH}/* ${DEPLOY_PATH}/.[!.]* 2>/dev/null; mkdir -p ${DEPLOY_PATH}`);
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const { artifactDir } = await makeArtifact('v-pre-ok');
    const provider = createSshProvider(
      config({
        preDeploy: [
          {
            command: `test ! -f ${DEPLOY_PATH}/index.html && echo PRE_BEFORE_EXTRACT`,
          },
        ],
      }),
      'production'
    );
    await provider.deploy(artifactDir);
    const out = text();
    expect(out).toMatch(/\[hook:preDeploy] \$ test ! -f/);
    expect(out).toMatch(/\[hook:preDeploy] PRE_BEFORE_EXTRACT/);
    const after = await remote(`cat ${DEPLOY_PATH}/index.html`);
    expect(after.stdout).toMatch(/v-pre-ok/);
    await fs.remove(artifactDir);
  });

  test('2. failing preDeploy (continueOnError false) aborts and does not extract', async () => {
    await remote(
      `rm -rf ${DEPLOY_PATH}/* 2>/dev/null; mkdir -p ${DEPLOY_PATH}; echo LIVE > ${DEPLOY_PATH}/live.txt`
    );
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const { artifactDir } = await makeArtifact('v-should-not-land');
    const provider = createSshProvider(
      config({
        preDeploy: [{ command: 'echo HOOK_ABORT; exit 1' }],
      }),
      'production'
    );
    await expect(provider.deploy(artifactDir)).rejects.toThrow(/preDeploy hook failed/);
    const out = text();
    expect(out).toMatch(/\[hook:preDeploy] \$ echo HOOK_ABORT; exit 1/);
    expect(out).toMatch(/HOOK_ABORT/);
    const live = await remote(`cat ${DEPLOY_PATH}/live.txt`);
    expect(live.stdout.trim()).toBe('LIVE');
    const index = await remote(`test -f ${DEPLOY_PATH}/index.html && echo yes || echo no`);
    expect(index.stdout.trim()).toBe('no');
    await fs.remove(artifactDir);
  });

  test('3. postDeploy failure with continueOnError true still reports success', async () => {
    await remote(`rm -rf ${DEPLOY_PATH}/* 2>/dev/null; mkdir -p ${DEPLOY_PATH}`);
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const { artifactDir } = await makeArtifact('v-post-warn');
    const provider = createSshProvider(
      config({
        postDeploy: [{ command: 'echo POST_WARN; exit 1', continueOnError: true }],
      }),
      'production'
    );
    await provider.deploy(artifactDir);
    const out = text();
    expect(out).toMatch(/\[hook:postDeploy]/);
    expect(out).toMatch(/postDeploy hook failed/);
    expect(out).toMatch(/Deployment complete/);
    const index = await remote(`cat ${DEPLOY_PATH}/index.html`);
    expect(index.stdout).toMatch(/v-post-warn/);
    await fs.remove(artifactDir);
  });

  test('4. hook timeoutMs fails loudly instead of hanging', async () => {
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const { artifactDir } = await makeArtifact('v-timeout');
    const provider = createSshProvider(
      config({
        preDeploy: [{ command: 'sleep 30', timeoutMs: 1500 }],
      }),
      'production'
    );
    const started = Date.now();
    await expect(provider.deploy(artifactDir)).rejects.toThrow(
      /preDeploy hook timed out after 1500ms/
    );
    expect(Date.now() - started).toBeLessThan(12000);
    await fs.remove(artifactDir);
  });

  test('5. rollback hook runs before restored files take over', async () => {
    await remote(`rm -rf ${DEPLOY_PATH}/* 2>/dev/null; mkdir -p ${DEPLOY_PATH}`);
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const v1 = await makeArtifact('v1-original');
    const v2 = await makeArtifact('v2-current');
    const provider = createSshProvider(
      config({
        rollback: [
          {
            command: `test ! -f ${DEPLOY_PATH}/index.html || grep -q v2-current ${DEPLOY_PATH}/index.html; echo ROLLBACK_BEFORE_RESTORE > /tmp/rollback-hook`,
          },
        ],
      }),
      'production'
    );
    await provider.deploy(v1.artifactDir);
    await provider.deploy(v2.artifactDir);
    logs.length = 0;
    await provider.rollback(v1.artifactDir, {});
    const out = text();
    expect(out).toMatch(/\[hook:rollback]/);
    expect(out).toMatch(/ROLLBACK_BEFORE_RESTORE|\$ test ! -f/);
    const marker = await remote('cat /tmp/rollback-hook');
    expect(marker.stdout.trim()).toBe('ROLLBACK_BEFORE_RESTORE');
    const restored = await remote(`cat ${DEPLOY_PATH}/index.html`);
    expect(restored.stdout).toMatch(/v1-original/);
    await fs.remove(v1.artifactDir);
    await fs.remove(v2.artifactDir);
  });

  test('6. environment with no hooks deploys without hook log lines', async () => {
    await remote(`rm -rf ${DEPLOY_PATH}/* 2>/dev/null; mkdir -p ${DEPLOY_PATH}`);
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const { artifactDir } = await makeArtifact('v-no-hooks');
    const provider = createSshProvider(config(undefined), 'production');
    await provider.deploy(artifactDir);
    const out = text();
    expect(out).not.toMatch(/\[hook:/);
    expect(out).toMatch(/Deployment complete/);
    const index = await remote(`cat ${DEPLOY_PATH}/index.html`);
    expect(index.stdout).toMatch(/v-no-hooks/);
    await fs.remove(artifactDir);
  });

  test('sensitive --password in the command string is withheld from the $ log', async () => {
    await remote(`rm -rf ${DEPLOY_PATH}/* 2>/dev/null; mkdir -p ${DEPLOY_PATH}`);
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const { artifactDir } = await makeArtifact('v-redact');
    const provider = createSshProvider(
      config({
        preDeploy: [
          {
            command:
              'echo REDACT_HOOK_RAN; true --password fake-secret-xyz',
          },
        ],
      }),
      'production'
    );
    await provider.deploy(artifactDir);
    const out = text();
    expect(out).toMatch(/\[hook:preDeploy] \$ <command withheld — possible credential in hook string>/);
    expect(out).not.toMatch(/fake-secret-xyz/);
    expect(out).toMatch(/\[hook:preDeploy] REDACT_HOOK_RAN/);
    await fs.remove(artifactDir);
  });

  test('preDeploy array short-circuits: second command does not run after abort', async () => {
    await remote(
      `rm -f /tmp/hook1 /tmp/hook2; rm -rf ${DEPLOY_PATH}/* 2>/dev/null; mkdir -p ${DEPLOY_PATH}; echo LIVE > ${DEPLOY_PATH}/live.txt`
    );
    const { createSshProvider } = await import('../src/deployment/providers/ssh.js');
    const { artifactDir } = await makeArtifact('v-short-circuit');
    const provider = createSshProvider(
      config({
        preDeploy: [
          { command: 'echo HOOK1_RAN > /tmp/hook1; echo HOOK1_RAN; exit 1' },
          { command: 'echo HOOK2_SHOULD_NOT_RUN > /tmp/hook2; echo HOOK2_SHOULD_NOT_RUN' },
        ],
      }),
      'production'
    );
    await expect(provider.deploy(artifactDir)).rejects.toThrow(/preDeploy hook failed/);
    const out = text();
    expect(out).toMatch(/HOOK1_RAN/);
    expect(out).not.toMatch(/HOOK2_SHOULD_NOT_RUN/);
    const one = await remote('cat /tmp/hook1 2>/dev/null; echo; test -f /tmp/hook2 && echo hook2yes || echo hook2no');
    expect(one.stdout).toMatch(/HOOK1_RAN/);
    expect(one.stdout).toMatch(/hook2no/);
    const live = await remote(`cat ${DEPLOY_PATH}/live.txt`);
    expect(live.stdout.trim()).toBe('LIVE');
    await fs.remove(artifactDir);
  });
});
