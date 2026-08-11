/**
 * Reproduce start-command hang against real Ubuntu sshd via node-ssh only.
 */
import { NodeSSH } from 'node-ssh';
import path from 'path';
import os from 'os';

const key = path.join(os.tmpdir(), 'deployhub-ssh-repro', 'id_ed25519');
const TIMEOUT = 4000;

const patterns = {
  old: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup ./fakeapp > app.log 2>&1 & echo $! > .deployhub.pid`,
  new_exec_a: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup bash -c 'exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp > app.log 2>&1 </dev/null & echo $! > .deployhub.pid`,
  redirect_all: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup ./fakeapp >app.log 2>&1 </dev/null & echo $! > .deployhub.pid`,
  close_fds_exec_a: `cd /home/deploy/app && DEPLOYHUB_APP=myapi bash -c 'exec 0</dev/null 1>app.log 2>&1; exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp & echo $! > .deployhub.pid`,
  setsid: `cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid ./fakeapp >app.log 2>&1 </dev/null & echo $! > .deployhub.pid`,
  setsid_exec_a: `cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid bash -c 'exec 0</dev/null 1>app.log 2>&1; exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp & echo $! > .deployhub.pid`,
  setsid_f: `cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid -f ./fakeapp >app.log 2>&1 </dev/null; echo $! > .deployhub.pid`,
  // Fully daemonize: background + close FDs in child before long sleep
  bash_daemon: `cd /home/deploy/app && DEPLOYHUB_APP=myapi bash -c 'exec 0</dev/null 1>app.log 2>&1; exec ./fakeapp' & echo $! > .deployhub.pid`,
  // Mark via argv0 AFTER closing FDs, then background — should return
  bash_daemon_exec_a: `cd /home/deploy/app && DEPLOYHUB_APP=myapi bash -c 'exec 0</dev/null 1>app.log 2>&1; exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp & echo $! > .deployhub.pid`,
  // env marker only + setsid -f (util-linux forks and returns)
  env_setsid_f: `cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid -f ./fakeapp >app.log 2>&1 </dev/null; pgrep -n -f '/home/deploy/app/fakeapp' > .deployhub.pid`,
  // cmdline marker via -- (python) skip
  // Use a tiny wrapper binary name: symlink with marker name? too hacky
  sleep_after: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup ./fakeapp >app.log 2>&1 </dev/null & echo $! > .deployhub.pid; sleep 1`,
};

async function withSsh(fn) {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: '127.0.0.1',
    port: 2222,
    username: 'deploy',
    privateKeyPath: key,
  });
  try {
    return await fn(ssh);
  } finally {
    ssh.dispose();
  }
}

async function reset() {
  await withSsh(async (ssh) => {
    await ssh.execCommand(
      `pkill -f '/home/deploy/app/fakeapp' >/dev/null 2>&1 || true; ` +
        `mkdir -p /home/deploy/app; ` +
        `printf '%s\\n' '#!/bin/bash' 'exec sleep 3600' > /home/deploy/app/fakeapp; ` +
        `chmod +x /home/deploy/app/fakeapp; ` +
        `rm -f /home/deploy/app/.deployhub.pid /home/deploy/app/app.log`
    );
  });
}

async function inspect() {
  return withSsh(async (ssh) => {
    const r = await ssh.execCommand(
      `pid=$(cat /home/deploy/app/.deployhub.pid 2>/dev/null | tr -cd '0-9'); ` +
        `echo PID=$pid; ` +
        `if [ -n "$pid" ] && [ -d /proc/$pid ]; then ` +
        `echo ALIVE; ` +
        `echo CMDLINE=$(tr '\\0' ' ' < /proc/$pid/cmdline); ` +
        `echo ENV=$(tr '\\0' '\\n' < /proc/$pid/environ | grep DEPLOYHUB || true); ` +
        `echo FDS=$(ls /proc/$pid/fd 2>/dev/null | tr '\\n' ' '); ` +
        `else echo DEAD_OR_MISSING; fi`
    );
    console.log('  ' + r.stdout.trim().replace(/\n/g, ' | '));
  });
}

async function timed(label, cmd) {
  return withSsh(async (ssh) => {
    const started = Date.now();
    let timer;
    try {
      const result = await Promise.race([
        ssh.execCommand(cmd),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('TIMEOUT')), TIMEOUT);
        }),
      ]);
      const ms = Date.now() - started;
      console.log(
        `OK   [${label}] ${ms}ms code=${result.code} out=${JSON.stringify(result.stdout.trim())}`
      );
      return true;
    } catch (e) {
      const ms = Date.now() - started;
      console.log(`FAIL [${label}] ${ms}ms ${e.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  });
}

async function main() {
  console.log('Preparing...');
  await reset();
  console.log('Running patterns (timeout', TIMEOUT, 'ms)\n');
  for (const [label, cmd] of Object.entries(patterns)) {
    await reset();
    console.log(`--- ${label} ---`);
    console.log(`CMD: ${cmd}`);
    const ok = await timed(label, cmd);
    // Always inspect — process may have started even if channel hung
    await inspect();
    if (!ok) {
      // Confirm "worked but hung" hypothesis
      const alive = await withSsh(async (ssh) => {
        const r = await ssh.execCommand(
          `pgrep -af fakeapp || true; pgrep -af 'DEPLOYHUB_APP=myapi' || true`
        );
        return r.stdout.trim();
      });
      console.log(`  leftover: ${alive || '(none)'}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
