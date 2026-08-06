/**
 * Real CLI wiring smoke test — spawn src/cli/index.js as a subprocess.
 * Run: node scripts/cli-smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli', 'index.js');

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ input?: string, timeoutMs?: number, env?: Record<string, string> }} [opts]
 */
function runCli(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
        ...(opts.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    if (opts.input != null) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        code: -1,
        stdout,
        stderr: stderr + '\n[TIMEOUT]',
        args,
      });
    }, opts.timeoutMs || 45000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, args });
    });
  });
}

function printResult(label, result) {
  console.log('\n' + '='.repeat(72));
  console.log(`CMD: deployhub ${result.args.join(' ')}`);
  console.log(`LABEL: ${label}`);
  console.log(`EXIT: ${result.code}`);
  console.log('-'.repeat(72));
  if (result.stdout.trim()) {
    console.log('STDOUT:');
    console.log(result.stdout.replace(/\x1b\[[0-9;]*m/g, ''));
  }
  if (result.stderr.trim()) {
    console.log('STDERR:');
    console.log(result.stderr.replace(/\x1b\[[0-9;]*m/g, ''));
  }
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-cli-smoke-'));
  console.log(`SCRATCH: ${scratch}`);

  const config = {
    project: 'smoke-app',
    version: '1.0.0',
    projectType: 'frontend',
    framework: 'react',
    port: 3000,
    defaultEnvironment: 'production',
    storage: ['local'],
    artifactRetention: 5,
    healthCheck: { url: 'https://example.invalid/health', timeout: 2 },
    pipeline: { build: true, deploy: true, notify: false },
    environments: {
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: {
          host: '10.0.0.1',
          user: 'deploy',
          deployPath: '/var/www/smoke-app',
          keyPath: '~/.ssh/id_rsa',
          healthCheckUrl: 'https://prod.example.invalid/health',
        },
      },
    },
  };
  await fs.writeJson(path.join(scratch, 'deployhub.config.json'), config, { spaces: 2 });

  const results = [];

  // 1. env list (fresh single-env)
  let r = await runCli(scratch, ['env', 'list']);
  printResult('env list on fresh single-env', r);
  results.push(r);

  // 2. env add staging — non-interactive wiring path (real subprocess)
  r = await runCli(scratch, ['env', 'add', 'staging', '--method', 'docker', '--yes'], {
    timeoutMs: 60000,
  });
  printResult('env add staging --method docker --yes', r);
  results.push({ ...r, _label: 'env-add' });

  // Also prove interactive prompt appears when run without --yes (piped stdin, expect prompt text)
  const promptProbe = await runCli(scratch, ['env', 'add', 'qa'], {
    input: '',
    timeoutMs: 8000,
  });
  printResult('env add qa (no --yes — expect interactive Deployment type prompt)', promptProbe);
  results.push(promptProbe);

  let cfg = await fs.readJson(path.join(scratch, 'deployhub.config.json'));
  if (!cfg.environments.staging) {
    console.log('\n[FAIL] env add --method docker --yes did not persist staging');
    process.exit(1);
  }
  // Ensure staging has health URL for verify smoke
  cfg.environments.staging.config = {
    ...(cfg.environments.staging.config || {}),
    healthCheckUrl: 'https://staging.example.invalid/health',
  };
  // Prefer SSH for disable/deploy messaging consistency in later steps? keep docker.
  if (!cfg.environments.production.config.healthCheckUrl) {
    cfg.environments.production.config.healthCheckUrl = 'https://prod.example.invalid/health';
  }
  await fs.writeJson(path.join(scratch, 'deployhub.config.json'), cfg, { spaces: 2 });

  r = await runCli(scratch, ['env', 'list']);
  printResult('env list after staging present', r);
  results.push(r);

  r = await runCli(scratch, ['env', 'disable', 'staging']);
  printResult('env disable staging', r);
  results.push(r);

  r = await runCli(scratch, ['env', 'list']);
  printResult('env list after disable', r);
  results.push(r);

  r = await runCli(scratch, ['deploy', '--env', 'staging']);
  printResult('deploy --env staging (disabled — should fail)', r);
  results.push(r);

  r = await runCli(scratch, ['env', 'enable', 'staging']);
  printResult('env enable staging', r);
  results.push(r);

  r = await runCli(scratch, ['deploy', '--env', 'doesnotexist']);
  printResult('deploy --env doesnotexist', r);
  results.push(r);

  r = await runCli(scratch, ['rollback', '--env', 'staging']);
  printResult('rollback --env staging (no prior deploy)', r);
  results.push(r);

  r = await runCli(scratch, ['verify', '--env', 'staging']);
  printResult('verify --env staging', r);
  results.push(r);

  r = await runCli(scratch, ['verify', '--env', 'all']);
  printResult('verify --env all', r);
  results.push(r);

  r = await runCli(scratch, ['sync-workflows']);
  printResult('sync-workflows', r);
  results.push(r);

  // remove staging — needs confirm prompt
  r = await runCli(scratch, ['env', 'remove', 'staging'], { input: 'y\n' });
  printResult('env remove staging (confirm y)', r);
  results.push(r);

  r = await runCli(scratch, ['--help']);
  printResult('--help', r);
  results.push(r);

  r = await runCli(scratch, ['env', '--help']);
  printResult('env --help', r);
  results.push(r);

  console.log('\n' + '='.repeat(72));
  console.log('SMOKE SUMMARY');
  console.log('='.repeat(72));
  for (const item of results) {
    console.log(
      `exit=${String(item.code).padStart(3)}  deployhub ${item.args.join(' ')}`
    );
  }
  console.log(`\nScratch left at: ${scratch}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
