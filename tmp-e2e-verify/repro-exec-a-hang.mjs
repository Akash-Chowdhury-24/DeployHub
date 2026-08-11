/**
 * Reproduce SSH start-command hang: simple nohup vs bash exec -a wrapper.
 * Uses real sshd (Docker) + node-ssh — not a JS mock.
 */
import { NodeSSH } from 'node-ssh';
import path from 'path';
import os from 'os';

const host = process.env.SSH_HOST || '127.0.0.1';
const port = Number(process.env.SSH_SSH_PORT || 2222);
const username = process.env.SSH_USER || 'deploy';
const privateKeyPath =
  process.env.SSH_KEY_PATH ||
  path.join(os.tmpdir(), 'deployhub-ssh-repro', 'id_ed25519');

const TIMEOUT_MS = Number(process.env.REPRO_TIMEOUT_MS || 8000);

async function timedExec(ssh, label, command) {
  const started = Date.now();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`TIMEOUT after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([ssh.execCommand(command), timeoutPromise]);
    const ms = Date.now() - started;
    console.log(
      `OK  [${label}] ${ms}ms code=${result.code} stdout=${JSON.stringify(result.stdout.trim())}`
    );
    return { ok: true, ms, result };
  } catch (err) {
    const ms = Date.now() - started;
    console.log(`FAIL [${label}] ${ms}ms ${err.message}`);
    return { ok: false, ms, err };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const ssh = new NodeSSH();
  await ssh.connect({ host, username, port, privateKeyPath });
  console.log(`connected to ${username}@${host}:${port}`);

  await ssh.execCommand(
    `mkdir -p /home/deploy/app && printf '%s\\n' '#!/bin/sh' 'echo started >> /home/deploy/app/app.log' 'while true; do sleep 30; done' > /home/deploy/app/fakeapp && chmod +x /home/deploy/app/fakeapp && pkill -f '/home/deploy/app/fakeapp' 2>/dev/null || true; rm -f /home/deploy/app/.deployhub.pid /home/deploy/app/app.log`
  );

  const dir = "'/home/deploy/app'";
  const pidFile = "'/home/deploy/app/.deployhub.pid'";
  const marker = "'DEPLOYHUB_APP=myapi'";
  const command = './fakeapp';

  // OLD (known good): simple nohup
  const oldCmd =
    `cd ${dir} && DEPLOYHUB_APP='myapi' nohup ${command} > app.log 2>&1 & echo $! > ${pidFile}`;

  // CURRENT (suspect): bash exec -a wrapper
  const newCmd =
    `cd ${dir} && DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@"' ${marker} ${command} > app.log 2>&1 </dev/null & echo $! > ${pidFile}`;

  // Variant A: redirects BEFORE nohup via subshell / explicit FD close pattern
  const variantA =
    `cd ${dir} && DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@"' ${marker} ${command} </dev/null >app.log 2>&1 & echo $! > ${pidFile}; disown 2>/dev/null || true`;

  // Variant B: double-fork / setsid style detach (no exec -a)
  const variantB =
    `cd ${dir} && DEPLOYHUB_APP='myapi' nohup ${command} > app.log 2>&1 </dev/null & echo $! > ${pidFile}`;

  // Variant C: put marker as literal argv0 via env-only (drop cmdline) + proper redirects
  const variantC =
    `cd ${dir} && DEPLOYHUB_APP='myapi' nohup ${command} > app.log 2>&1 </dev/null & echo $! > ${pidFile}`;

  // Variant D: use setsid + exec -a inside a fully redirected compound command
  const variantD =
    `cd ${dir} && ( DEPLOYHUB_APP='myapi' setsid -f bash -c 'exec -a "$0" "$@"' ${marker} ${command} > app.log 2>&1 </dev/null & echo $! > ${pidFile} )`;

  // Variant E: python -c to set process title? skip — keep shell simple
  // Variant F: wrapper script approach written then executed
  const variantFPrepare =
    `printf '%s\\n' '#!/bin/bash' 'export DEPLOYHUB_APP=myapi' 'exec -a "DEPLOYHUB_APP=myapi" ./fakeapp' > /home/deploy/app/run-marked.sh && chmod +x /home/deploy/app/run-marked.sh`;
  const variantF =
    `cd ${dir} && nohup ./run-marked.sh > app.log 2>&1 </dev/null & echo $! > ${pidFile}`;

  // Variant G: bash -c with redirects INSIDE the -c script (critical FD close timing)
  const variantG =
    `cd ${dir} && DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@" </dev/null >app.log 2>&1' ${marker} ${command} & echo $! > ${pidFile}`;

  // Variant H: like G but also close inherited FDs via redirect on the outer bg job
  const variantH =
    `cd ${dir} && DEPLOYHUB_APP='myapi' bash -c 'exec -a "$0" "$@"' ${marker} ${command} > app.log 2>&1 </dev/null & echo $! > ${pidFile}`;

  const cases = [
    ['OLD_simple_nohup', oldCmd],
    ['NEW_exec_a', newCmd],
    ['B_simple_plus_stdin', variantB],
    ['C_same_as_B', variantC],
    ['H_no_nohup_exec_a', variantH],
    ['G_redirects_inside_c', variantG],
    ['D_setsid', variantD],
  ];

  for (const [label, cmd] of cases) {
    await ssh.execCommand(
      `pkill -f '/home/deploy/app/fakeapp' 2>/dev/null || true; pkill -f 'DEPLOYHUB_APP=myapi' 2>/dev/null || true; rm -f /home/deploy/app/.deployhub.pid /home/deploy/app/app.log; sleep 0.2`
    );
    console.log(`\n--- ${label} ---`);
    console.log(`CMD: ${cmd}`);
    const r = await timedExec(ssh, label, cmd);
    if (r.ok) {
      const check = await ssh.execCommand(
        `pid=$(cat /home/deploy/app/.deployhub.pid 2>/dev/null); echo PID=$pid; if [ -n "$pid" ] && [ -d /proc/$pid ]; then echo ALIVE; echo -n CMDLINE=; tr '\\0' ' ' < /proc/$pid/cmdline; echo; echo -n ENV_MARK=; tr '\\0' '\\n' < /proc/$pid/environ | grep -F DEPLOYHUB_APP || true; else echo DEAD; fi`
      );
      console.log(check.stdout.trim());
    }
  }

  // Variant F separately (needs prepare)
  await ssh.execCommand(variantFPrepare);
  await ssh.execCommand(
    `pkill -f '/home/deploy/app/fakeapp' 2>/dev/null || true; rm -f /home/deploy/app/.deployhub.pid /home/deploy/app/app.log`
  );
  console.log(`\n--- F_wrapper_script ---`);
  console.log(`CMD: ${variantF}`);
  const fr = await timedExec(ssh, 'F_wrapper_script', variantF);
  if (fr.ok) {
    const check = await ssh.execCommand(
      `pid=$(cat /home/deploy/app/.deployhub.pid 2>/dev/null); echo PID=$pid; if [ -n "$pid" ] && [ -d /proc/$pid ]; then echo ALIVE; echo -n CMDLINE=; tr '\\0' ' ' < /proc/$pid/cmdline; echo; echo -n ENV_MARK=; tr '\\0' '\\n' < /proc/$pid/environ | grep -F DEPLOYHUB_APP || true; else echo DEAD; fi`
    );
    console.log(check.stdout.trim());
  }

  // Also test A
  await ssh.execCommand(
    `pkill -f '/home/deploy/app/fakeapp' 2>/dev/null || true; rm -f /home/deploy/app/.deployhub.pid /home/deploy/app/app.log`
  );
  console.log(`\n--- A_disown ---`);
  const ar = await timedExec(ssh, 'A_disown', variantA);
  if (ar.ok) {
    const check = await ssh.execCommand(
      `pid=$(cat /home/deploy/app/.deployhub.pid 2>/dev/null); echo PID=$pid; tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null; echo`
    );
    console.log(check.stdout.trim());
  }

  ssh.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
