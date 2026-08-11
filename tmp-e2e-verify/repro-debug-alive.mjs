import { NodeSSH } from 'node-ssh';
import path from 'path';
import os from 'os';

const key = path.join(os.tmpdir(), 'deployhub-ssh-repro', 'id_ed25519');
const ssh = new NodeSSH();
await ssh.connect({
  host: '127.0.0.1',
  port: 2222,
  username: 'deploy',
  privateKeyPath: key,
});

const setup = [
  'mkdir -p /home/deploy/app',
  'cd /home/deploy/app',
  "printf '%s\\n' '#!/bin/bash' 'echo RUNNING > /tmp/fa.log' 'exec sleep 3600' > fakeapp",
  'chmod +x fakeapp',
  'pkill -f \"/home/deploy/app/fakeapp\" >/dev/null 2>&1 || true',
  'pkill -f \"DEPLOYHUB_APP=myapi\" >/dev/null 2>&1 || true',
  'rm -f .deployhub.pid app.log /tmp/fa.log',
].join(' && ');

console.log('setup', await ssh.execCommand(setup));

const start =
  `cd /home/deploy/app && ` +
  `DEPLOYHUB_APP=myapi nohup bash -c 'exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' ./fakeapp > app.log 2>&1 </dev/null & ` +
  `echo $! > .deployhub.pid`;

console.log('START CMD:', start);
const started = Date.now();
const r = await ssh.execCommand(start);
console.log('start returned in', Date.now() - started, 'ms', r);

await new Promise((r) => setTimeout(r, 500));

const check = await ssh.execCommand(
  [
    'cd /home/deploy/app',
    'echo PIDFILE=$(cat .deployhub.pid 2>/dev/null)',
    'echo FA_LOG=$(cat /tmp/fa.log 2>/dev/null)',
    'echo APP_LOG=$(cat app.log 2>/dev/null)',
    'ps -ef | grep -E \"fakeapp|sleep|DEPLOYHUB\" | grep -v grep || true',
    'pid=$(cat .deployhub.pid 2>/dev/null | tr -cd 0-9)',
    'if [ -n \"$pid\" ] && [ -d /proc/$pid ]; then',
    '  echo ALIVE',
    '  echo CMDLINE=$(tr \"\\0\" \" \" < /proc/$pid/cmdline)',
    '  echo ENV=$(tr \"\\0\" \"\\n\" < /proc/$pid/environ | grep DEPLOYHUB || true)',
    '  ls -l /proc/$pid/fd',
    'else echo DEAD; fi',
  ].join('; ')
);
console.log(check.stdout);
console.log('stderr', check.stderr);

// Also compare OLD
await ssh.execCommand(
  'pkill -f \"/home/deploy/app/fakeapp\" >/dev/null 2>&1 || true; rm -f /home/deploy/app/.deployhub.pid /tmp/fa.log'
);
const old =
  `cd /home/deploy/app && DEPLOYHUB_APP=myapi nohup ./fakeapp > app.log 2>&1 & echo $! > .deployhub.pid`;
const t0 = Date.now();
const r2 = await ssh.execCommand(old);
console.log('OLD returned in', Date.now() - t0, 'ms', r2);
await new Promise((r) => setTimeout(r, 500));
const check2 = await ssh.execCommand(
  'cd /home/deploy/app; echo PIDFILE=$(cat .deployhub.pid); ps -ef | grep -E \"fakeapp|sleep\" | grep -v grep; pid=$(cat .deployhub.pid | tr -cd 0-9); echo CMDLINE=$(tr \"\\0\" \" \" < /proc/$pid/cmdline 2>/dev/null); echo ENV=$(tr \"\\0\" \"\\n\" < /proc/$pid/environ 2>/dev/null | grep DEPLOY || true)'
);
console.log(check2.stdout);

ssh.dispose();
