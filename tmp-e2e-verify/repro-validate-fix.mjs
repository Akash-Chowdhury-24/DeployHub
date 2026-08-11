import { NodeSSH } from 'node-ssh';
import { execa } from 'execa';
import path from 'path';
import os from 'os';

const key = path.join(os.tmpdir(), 'deployhub-ssh-repro', 'id_ed25519');
const TIMEOUT = 5000;
const dir = '/home/deploy/app';
const pidFile = `${dir}/.deployhub.pid`;
const marker = `'DEPLOYHUB_APP=myapi'`;
const command = './fakeapp';

async function reset() {
  await execa('docker', [
    'exec',
    'deployhub-sshd',
    'bash',
    '-c',
    `killall -u deploy sleep 2>/dev/null || true; ` +
      `mkdir -p ${dir}; ` +
      `printf '%s\\n' '#!/bin/bash' 'exec sleep 3600' > ${dir}/fakeapp; ` +
      `chmod +x ${dir}/fakeapp; ` +
      `rm -f ${pidFile} ${dir}/app.log; true`,
  ]);
}

async function timed(label, cmd) {
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
    const ms = Date.now() - t0;
    const insp = await ssh.execCommand(
      `pid=$(tr -cd 0-9 < ${pidFile} 2>/dev/null); ` +
        `echo ms=${ms}; echo PID=$pid; ` +
        `if [ -n "$pid" ] && [ -d /proc/$pid ]; then ` +
        `echo ALIVE; echo CMDLINE=$(tr '\\0' ' ' < /proc/$pid/cmdline); ` +
        `echo ENV=$(tr '\\0' '\\n' < /proc/$pid/environ | grep '^DEPLOYHUB' || true); ` +
        `else echo DEAD; fi`
    );
    console.log(`OK   [${label}] ${ms}ms`);
    console.log(' ', insp.stdout.replace(/\n/g, ' | '));
    return ms;
  } catch (e) {
    console.log(`FAIL [${label}] ${Date.now() - t0}ms ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
    ssh.dispose();
  }
}

// BEFORE (current buggy): cd && nohup ... &
const before =
  `cd '${dir}' && DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@"' ${marker} ${command} > app.log 2>&1 </dev/null & echo $! > '${pidFile}'`;

// AFTER A: semicolon instead of && before nohup (cd; nohup ... &)
const afterSemicolon =
  `cd '${dir}'; DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@"' ${marker} ${command} > app.log 2>&1 </dev/null & echo $! > '${pidFile}'`;

// AFTER B: brace group keeps && for cd failure semantics
const afterBrace =
  `cd '${dir}' && { DEPLOYHUB_APP='myapi' nohup bash -c 'exec -a "$0" "$@"' ${marker} ${command} > app.log 2>&1 </dev/null & echo $! > '${pidFile}'; }`;

// AFTER C: drop exec -a, brace + env-only (max reliability)
const afterEnvOnly =
  `cd '${dir}' && { DEPLOYHUB_APP='myapi' nohup ${command} > app.log 2>&1 </dev/null & echo $! > '${pidFile}'; }`;

// AFTER D: setsid -f + exec -a + pid from child
const afterSetsid =
  `cd '${dir}' && DEPLOYHUB_APP='myapi' setsid -f bash -c 'echo $$ > /home/deploy/app/.deployhub.pid; exec >app.log 2>&1 </dev/null; exec -a "$0" "$@"' ${marker} ${command}`;

await reset();
console.log('BEFORE (current)');
console.log(before);
await timed('before', before);

await reset();
console.log('\nAFTER semicolon');
console.log(afterSemicolon);
await timed('after_semicolon', afterSemicolon);

await reset();
console.log('\nAFTER brace');
console.log(afterBrace);
await timed('after_brace', afterBrace);

await reset();
console.log('\nAFTER env-only brace');
console.log(afterEnvOnly);
await timed('after_env_only', afterEnvOnly);

await reset();
console.log('\nAFTER setsid');
console.log(afterSetsid);
await timed('after_setsid', afterSetsid);
