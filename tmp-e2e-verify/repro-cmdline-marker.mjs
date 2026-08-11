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

async function inspect() {
  const insp = await ssh.execCommand(
    `pid=$(tr -cd 0-9 < /home/deploy/app/.deployhub.pid); ` +
      `echo PID=$pid; ` +
      `echo CMDLINE=$(tr '\\0' ' ' < /proc/$pid/cmdline); ` +
      `echo ENV=$(tr '\\0' '\\n' < /proc/$pid/environ | grep DEPLOY)`
  );
  console.log(insp.stdout);
}

// Direct binary (sleep) with brace+exec -a — mimics uvicorn binary
const brace =
  `cd '/home/deploy/app' && { DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' sleep 3600 > app.log 2>&1 </dev/null & echo $! > '/home/deploy/app/.deployhub.pid'; }`;
await ssh.execCommand('rm -f /home/deploy/app/.deployhub.pid; killall -u deploy sleep 2>/dev/null || true');
const t0 = Date.now();
await ssh.execCommand(brace);
console.log('brace+exec-a on sleep binary', Date.now() - t0, 'ms');
await inspect();

const setsid =
  `cd '/home/deploy/app' && DEPLOYHUB_APP='myapi' setsid -f bash -c 'echo $$ > /home/deploy/app/.deployhub.pid; exec >app.log 2>&1 </dev/null; exec -a "$0" "$@"' 'DEPLOYHUB_APP=myapi' sleep 3600`;
await ssh.execCommand(
  'kill $(tr -cd 0-9 < /home/deploy/app/.deployhub.pid) 2>/dev/null || true; rm -f /home/deploy/app/.deployhub.pid'
);
const t1 = Date.now();
await ssh.execCommand(setsid);
console.log('setsid+exec-a on sleep binary', Date.now() - t1, 'ms');
await inspect();

ssh.dispose();
