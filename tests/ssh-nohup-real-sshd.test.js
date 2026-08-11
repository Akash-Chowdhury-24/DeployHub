/**
 * Real-sshd regression: brace-grouped startScopedNohup returns promptly over
 * node-ssh, with DEPLOYHUB_APP visible in environ and cmdline.
 *
 * Background (confirmed on Ubuntu 24.04 sshd + node-ssh during investigation):
 * `cd dir && nohup cmd & echo $!` parses as `(cd dir && nohup cmd) & echo $!`.
 * That can leave the SSH session hung while the app still starts (false failure).
 * Brace form `cd dir && { nohup cmd & echo $!; }` returns immediately.
 *
 * Note: whether the *buggy* form hangs is host/OpenSSH/bash dependent (seen on
 * some Ubuntu setups, not on all CI runners). This suite therefore asserts the
 * fixed form's reliability + markers — not that the buggy form hangs.
 *
 * Requires Docker. describe.skip when Docker is unavailable.
 */
import { jest } from '@jest/globals';
import { execa } from 'execa';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { NodeSSH } from 'node-ssh';

const CONTAINER = 'deployhub-test-sshd';
const IMAGE = 'deployhub-test-sshd:ubuntu';
const SSH_PORT = 2223;
const START_BUDGET_MS = 5000;

/** @returns {Promise<boolean>} */
async function dockerAvailable() {
  try {
    await execa('docker', ['ps', '-q'], { timeout: 20000 });
    return true;
  } catch (err) {
    console.warn(
      'Docker unavailable — skipping real-sshd tests:',
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

const HAS_DOCKER = await dockerAvailable();
const describeRealSsh = HAS_DOCKER ? describe : describe.skip;

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
      openssh-server util-linux bash procps \\
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
 * Fixed startScopedNohup template (brace-grouped).
 * @param {string} deployPath
 * @param {string} body
 */
function fixedStartCommand(deployPath, body) {
  const marker = `'DEPLOYHUB_APP=myapi'`;
  return (
    `cd '${deployPath}' && { DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@"' ${marker} ${body} > app.log 2>&1 </dev/null & echo $! > '${deployPath}/.deployhub.pid'; }`
  );
}

/**
 * @param {import('node-ssh').NodeSSH} ssh
 * @param {string} deployPath
 */
async function waitForMarkers(ssh, deployPath) {
  const deadline = Date.now() + 3000;
  /** @type {{ code: number|null, stdout: string } | null} */
  let last = null;
  while (Date.now() < deadline) {
    last = await ssh.execCommand(
      `pid=$(tr -cd 0-9 < ${deployPath}/.deployhub.pid 2>/dev/null); ` +
        `echo PID=$pid; ` +
        `if [ -z "$pid" ] || [ ! -d /proc/$pid ]; then echo DEAD; exit 1; fi; ` +
        `echo ENV=$(tr '\\0' '\\n' < /proc/$pid/environ | grep '^DEPLOYHUB_APP=' || true); ` +
        `if tr '\\0' '\\n' < /proc/$pid/cmdline | grep -qxF 'DEPLOYHUB_APP=myapi'; then echo CMDLINE_HAS_MARKER=yes; else echo CMDLINE_HAS_MARKER=no; exit 1; fi; ` +
        `tr '\\0' '\\n' < /proc/$pid/environ | grep -qxF 'DEPLOYHUB_APP=myapi'`
    );
    if (last.code === 0) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `markers not visible within 3s: ${(last && last.stdout) || '(no output)'}`
  );
}

describeRealSsh('startScopedNohup real SSH completion (Docker sshd)', () => {
  jest.setTimeout(300000);

  /** @type {string} */
  let tmp;
  /** @type {string} */
  let keyPath;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-real-ssh-'));
    keyPath = await ensureSshd(tmp);
  });

  afterAll(async () => {
    if (tmp) await fs.remove(tmp).catch(() => {});
    await execa('docker', ['rm', '-f', CONTAINER], { reject: false });
  });

  test('brace-grouped exec -a returns <5s with environ+cmdline markers for all startScopedNohup languages', async () => {
    const ssh = new NodeSSH();
    await ssh.connect({
      host: '127.0.0.1',
      port: SSH_PORT,
      username: 'deploy',
      privateKeyPath: keyPath,
    });

    try {
      // Same helper for FastAPI / Go / Java / .NET / Rails bodies.
      for (const fw of ['fastapi', 'go', 'spring', 'dotnet', 'rails']) {
        const deployPath = `/home/deploy/app-${fw}`;
        await ssh.execCommand(
          `mkdir -p ${deployPath} && rm -f ${deployPath}/.deployhub.pid ${deployPath}/app.log`
        );
        const cmd = fixedStartCommand(deployPath, 'sleep 3600');
        // Shape guard: must stay brace-grouped (not bare `cd && nohup … &`).
        expect(cmd).toMatch(/cd .+ && \{[\s\S]*nohup[\s\S]*& echo \$!/);

        const t0 = Date.now();
        const result = await Promise.race([
          ssh.execCommand(cmd),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error(`${fw} start exceeded ${START_BUDGET_MS}ms`)),
              START_BUDGET_MS
            )
          ),
        ]);
        expect(result.code).toBe(0);
        expect(Date.now() - t0).toBeLessThan(START_BUDGET_MS);

        const check = await waitForMarkers(ssh, deployPath);
        expect(check.code).toBe(0);
        expect(check.stdout).toMatch(/PID=\d+/);
        expect(check.stdout).toMatch(/ENV=DEPLOYHUB_APP=myapi/);
        expect(check.stdout).toMatch(/CMDLINE_HAS_MARKER=yes/);

        await ssh.execCommand(
          `kill "$(tr -cd 0-9 < ${deployPath}/.deployhub.pid)" 2>/dev/null || true`
        );
      }
    } finally {
      ssh.dispose();
    }
  });
});
