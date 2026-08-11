/**
 * Careful hang repro: never pkill -f a pattern that appears in the SSH command line.
 */
import { NodeSSH } from 'node-ssh';
import path from 'path';
import os from 'os';

const key = path.join(os.tmpdir(), 'deployhub-ssh-repro', 'id_ed25519');
const TIMEOUT = 6000;

async function connect() {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: '127.0.0.1',
    port: 2222,
    username: 'deploy',
    privateKeyPath: key,
  });
  return ssh;
}

async function cleanup(ssh) {
  // Kill by pidfile only — avoid pkill -f matching this SSH command itself.
  await ssh.execCommand(
    `if [ -f /home/deploy/app/.deployhub.pid ]; then ` +
      `kill "$(tr -cd 0-9 < /home/deploy/app/.deployhub.pid)" 2>/dev/null || true; ` +
      `fi; ` +
      `mkdir -p /home/deploy/app; ` +
      `printf '%s\\n' '#!/bin/bash' 'echo RUNNING > /tmp/fa.log' 'exec sleep 3600' > /home/deploy/app/fakeapp; ` +
      `chmod +x /home/deploy/app/fakeapp; ` +
      `rm -f /home/deploy/app/.deployhub.pid /home/deploy/app/app.log /tmp/fa.log`
  );
}

async function timedExec(ssh, label, cmd) {
  const started = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      ssh.execCommand(cmd),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('TIMEOUT')), TIMEOUT);
      }),
    ]);
    console.log(
      `OK   [${label}] ${Date.now() - started}ms code=${result.code} out=${JSON.stringify(result.stdout.trim())}`
    );
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    console.log(`FAIL [${label}] ${Date.now() - started}ms ${e.message}`);
    return { ok: false, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function inspect(ssh) {
  const r = await ssh.execCommand(
    `pid=$(tr -cd 0-9 < /home/deploy/app/.deployhub.pid 2>/dev/null); ` +
      `echo PIDFILE=$pid; ` +
      `echo FA=$(cat /tmp/fa.log 2>/dev/null); ` +
      `if [ -n "$pid" ] && [ -d /proc/$pid ]; then ` +
      `echo ALIVE; ` +
      `echo CMDLINE=$(tr '\\0' ' ' < /proc/$pid/cmdline); ` +
      `echo ENV=$(tr '\\0' '\\n' < /proc/$pid/environ | grep '^DEPLOYHUB' || true); ` +
      `echo FD_COUNT=$(ls /proc/$pid/fd 2>/dev/null | wc -l); ` +
      `ls -l /proc/$pid/fd 2>/dev/null | sed -n '1,20p'; ` +
      `else echo DEAD; ps -u deploy -o pid,cmd --no-headers | head -20; fi`
  );
  console.log(r.stdout);
}

const cases = {
  old: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup ./fakeapp > app.log 2>&1 & echo $! > .deployhub.pid`,
  old_with_stdin: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup ./fakeapp > app.log 2>&1 </dev/null & echo $! > .deployhub.pid`,
  new_exec_a: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup bash -c 'exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp > app.log 2>&1 </dev/null & echo $! > .deployhub.pid`,
  // redirects applied inside -c before exec -a
  exec_a_inner_redir: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup bash -c 'exec 0</dev/null 1>app.log 2>&1; exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp & echo $! > .deployhub.pid`,
  // no nohup, close FDs then exec -a
  no_nohup_close_exec_a: `cd /home/deploy/app && DEPLOYHUB_APP=myapi bash -c 'exec 0</dev/null 1>app.log 2>&1; exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp & echo $! > .deployhub.pid`,
  // setsid -f returns immediately by design
  setsid_f_env: `cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid -f ./fakeapp >app.log 2>&1 </dev/null && pgrep -n -u deploy sleep > .deployhub.pid`,
  // setsid -f + exec -a for cmdline marker
  setsid_f_exec_a: `cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid -f bash -c 'exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp >app.log 2>&1 </dev/null && pgrep -n -u deploy -f 'DEPLOYHUB_APP=myapi' > .deployhub.pid`,
  // env-only (reliable) — drop cmdline visibility
  env_only: `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup ./fakeapp > app.log 2>&1 </dev/null & echo $! > .deployhub.pid`,
};

async function main() {
  // Fresh connection per case so a hung channel can't poison the next.
  for (const [label, cmd] of Object.entries(cases)) {
    console.log(`\n======== ${label} ========`);
    console.log(cmd);
    const ssh = await connect();
    try {
      await cleanup(ssh);
      const result = await timedExec(ssh, label, cmd);
      // New connection for inspect if start hung (channel may be stuck)
      if (!result.ok) {
        ssh.dispose();
        const ssh2 = await connect();
        try {
          await inspect(ssh2);
        } finally {
          ssh2.dispose();
        }
      } else {
        await inspect(ssh);
      }
    } finally {
      try {
        ssh.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
