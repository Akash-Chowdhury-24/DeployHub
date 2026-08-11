import { NodeSSH } from 'node-ssh';
import path from 'path';
import os from 'os';

const key = path.join(os.tmpdir(), 'deployhub-ssh-repro', 'id_ed25519');
const TIMEOUT = 5000;

async function run(label, cmd) {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: '127.0.0.1',
    port: 2222,
    username: 'deploy',
    privateKeyPath: key,
  });
  const t0 = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      ssh.execCommand(cmd),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('TIMEOUT')), TIMEOUT);
      }),
    ]);
    console.log(
      `OK   [${label}] ${Date.now() - t0}ms code=${result.code} out=${JSON.stringify(result.stdout.trim())} err=${JSON.stringify(result.stderr.trim())}`
    );
  } catch (e) {
    console.log(`FAIL [${label}] ${Date.now() - t0}ms ${e.message}`);
  } finally {
    clearTimeout(timer);
    ssh.dispose();
  }
}

// Kill leftover sleeps via docker (not via SSH pkill -f)
import { execa } from 'execa';
await execa('docker', [
  'exec',
  'deployhub-sshd',
  'bash',
  '-c',
  'killall -u deploy sleep 2>/dev/null || true; killall -u deploy bash 2>/dev/null || true; rm -f /home/deploy/.deployhub.pid /home/deploy/app/.deployhub.pid; true',
]);

const tests = [
  ['bare_sleep_bg', 'sleep 30 & echo DONE_$!'],
  ['bare_sleep_bg_exit', 'sleep 30 & echo DONE_$!; exit 0'],
  ['nohup_sleep', 'nohup sleep 30 >/tmp/s.log 2>&1 </dev/null & echo DONE_$!'],
  ['nohup_sleep_disown', 'nohup sleep 30 >/tmp/s.log 2>&1 </dev/null & echo DONE_$!; disown -a 2>/dev/null; exit 0'],
  ['setsid_f_sleep', 'setsid -f sleep 30 >/tmp/s.log 2>&1 </dev/null; echo DONE'],
  [
    'and_bg_precedence',
    'cd /home/deploy/app && nohup sleep 30 >app.log 2>&1 </dev/null & echo DONE_$!; ls -la /home/deploy/.deployhub.pid /home/deploy/app/.deployhub.pid 2>&1; pwd',
  ],
  [
    'write_pid_abs',
    'cd /home/deploy/app && nohup sleep 30 >app.log 2>&1 </dev/null & echo $! > /home/deploy/app/.deployhub.pid; echo DONE; cat /home/deploy/app/.deployhub.pid',
  ],
  [
    'subshell_group',
    'cd /home/deploy/app && { nohup sleep 30 >app.log 2>&1 </dev/null & echo $! > /home/deploy/app/.deployhub.pid; }',
  ],
  [
    'explicit_bg_only_cmd',
    'cd /home/deploy/app; nohup sleep 30 >app.log 2>&1 </dev/null & echo $! > /home/deploy/app/.deployhub.pid; echo DONE',
  ],
  // FIX candidate: setsid -f + pid from child
  [
    'fix_setsid_pid',
    'cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid -f bash -c \'echo $$ > /home/deploy/app/.deployhub.pid; exec >app.log 2>&1 </dev/null; exec "$@"\' bash sleep 30; echo DONE; cat /home/deploy/app/.deployhub.pid; tr "\\0" " " < /proc/$(cat /home/deploy/app/.deployhub.pid)/cmdline; echo; tr "\\0" "\\n" < /proc/$(cat /home/deploy/app/.deployhub.pid)/environ | grep DEPLOY',
  ],
  // FIX candidate: setsid -f + exec -a marker
  [
    'fix_setsid_exec_a',
    'cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid -f bash -c \'echo $$ > /home/deploy/app/.deployhub.pid; exec >app.log 2>&1 </dev/null; exec -a "$0" "$@"\' \'DEPLOYHUB_APP=myapi\' sleep 30; echo DONE; cat .deployhub.pid; echo CMDLINE=$(tr "\\0" " " < /proc/$(cat .deployhub.pid)/cmdline); echo ENV=$(tr "\\0" "\\n" < /proc/$(cat .deployhub.pid)/environ | grep DEPLOY)',
  ],
  // FIX candidate: env-only setsid -f, simpler PID write
  [
    'fix_setsid_env_only',
    'cd /home/deploy/app && DEPLOYHUB_APP=myapi setsid -f bash -c \'echo $$ > /home/deploy/app/.deployhub.pid; exec >app.log 2>&1 </dev/null; exec "$@"\' bash sleep 30; echo DONE; echo CMDLINE=$(tr "\\0" " " < /proc/$(cat .deployhub.pid)/cmdline); echo ENV=$(tr "\\0" "\\n" < /proc/$(cat .deployhub.pid)/environ | grep DEPLOY)',
  ],
];

for (const [label, cmd] of tests) {
  await execa('docker', [
    'exec',
    'deployhub-sshd',
    'bash',
    '-c',
    'killall -u deploy sleep 2>/dev/null || true; true',
  ]);
  console.log(`\n--- ${label} ---`);
  await run(label, cmd);
}
