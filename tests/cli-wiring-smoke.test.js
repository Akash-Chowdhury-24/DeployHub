/**
 * Spawns the REAL CLI binary (src/cli/index.js) — not imported command functions.
 * Covers env add --method/--yes wiring that pure unit tests miss.
 */
import { jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli', 'index.js');

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 */
function runCli(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timeout: deployhub ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, opts.timeoutMs || 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe('CLI wiring smoke (real subprocess)', () => {
  jest.setTimeout(60000);

  /** @type {string} */
  let scratch;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-cli-wire-'));
    await fs.writeJson(
      path.join(scratch, 'deployhub.config.json'),
      {
        project: 'wire-app',
        version: '1.0.0',
        projectType: 'frontend',
        framework: 'react',
        port: 3000,
        defaultEnvironment: 'production',
        storage: ['local'],
        pipeline: { build: true, deploy: true, notify: false },
        environments: {
          production: {
            enabled: true,
            method: 'ssh',
            trigger: 'manual',
            config: {
              host: '10.0.0.1',
              user: 'deploy',
              deployPath: '/var/www/wire-app',
            },
          },
        },
      },
      { spaces: 2 }
    );
  });

  afterEach(async () => {
    await fs.remove(scratch).catch(() => {});
  });

  test('deployhub env add staging --method docker --yes persists staging via real CLI', async () => {
    const result = await runCli(scratch, [
      'env',
      'add',
      'staging',
      '--method',
      'docker',
      '--yes',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Added environment "staging"/);
    expect(result.stdout + result.stderr).toMatch(/docker/i);

    const cfg = await fs.readJson(path.join(scratch, 'deployhub.config.json'));
    expect(cfg.environments.staging).toBeTruthy();
    expect(cfg.environments.staging.method).toBe('docker');
    expect(cfg.environments.staging.enabled).toBe(true);
    expect(cfg.unprefixedSecretEnvironment).toBe('production');
    expect(cfg.environments.staging.config.dockerImageName).toBe('wire-app');
    expect(cfg.environments.staging.config.port).toBeUndefined();
    expect(cfg.environments.staging.branch).toBeUndefined();

    const list = await runCli(scratch, ['env', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/staging/);
    expect(list.stdout).toMatch(/docker/);
  });

  test('deployhub env add --yes without --method fails with clear wiring error', async () => {
    const result = await runCli(scratch, ['env', 'add', 'qa', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/--method/);
  });

  test('deploy --help / verify --help / env --help expose multi-env commands', async () => {
    const deploy = await runCli(scratch, ['deploy', '--help']);
    expect(deploy.code).toBe(0);
    expect(deploy.stdout).toMatch(/--env <name>/);

    const verify = await runCli(scratch, ['verify', '--help']);
    expect(verify.code).toBe(0);
    expect(verify.stdout).toMatch(/--env <name>/);

    const envHelp = await runCli(scratch, ['env', '--help']);
    expect(envHelp.code).toBe(0);
    expect(envHelp.stdout).toMatch(/add \[options\] <name>|add <name>/);
    expect(envHelp.stdout).toMatch(/list/);
    expect(envHelp.stdout).toMatch(/enable/);
    expect(envHelp.stdout).toMatch(/disable/);
    expect(envHelp.stdout).toMatch(/remove/);
  });
});
