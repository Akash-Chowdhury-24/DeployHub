/**
 * Missing-config handling + CLI fatal-error formatting.
 * Spawns the real CLI for doctor/deploy/etc.; unit-tests formatFatalCliError.
 */
import { jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { formatFatalCliError } from '../src/cli/fatal-error.js';
import {
  isConfigMissingError,
  printMissingConfigError,
} from '../src/core/load-config-or-exit.js';

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

/**
 * @param {string} out
 */
function assertCleanMissingConfig(out) {
  expect(out).toMatch(/No deployhub\.config\.json found/i);
  expect(out).toMatch(/deployhub init/i);
  expect(out).not.toMatch(/TypeError/i);
  expect(out).not.toMatch(/Cannot read properties of null/i);
  expect(out).not.toMatch(/[/\\]snapshot[/\\]/i);
  expect(out).not.toMatch(/\s+at\s+\S+/);
}

describe('missing config + fatal CLI errors', () => {
  jest.setTimeout(60000);

  /** @type {string} */
  let emptyDir;

  beforeEach(async () => {
    emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-no-config-'));
  });

  afterEach(async () => {
    await fs.remove(emptyDir).catch(() => {});
  });

  test('isConfigMissingError detects loadConfig not-found errors', () => {
    expect(isConfigMissingError(new Error('Config not found at /tmp/x. Run "deployhub init" first.'))).toBe(
      true
    );
    expect(isConfigMissingError(new Error('Zod validation failed'))).toBe(false);
  });

  test('printMissingConfigError writes the friendly two-line message', () => {
    const lines = [];
    const orig = console.error;
    console.error = (...args) => {
      lines.push(args.join(' '));
    };
    try {
      printMissingConfigError();
    } finally {
      console.error = orig;
    }
    const text = lines.join('\n');
    expect(text).toMatch(/No deployhub\.config\.json found/);
    expect(text).toMatch(/deployhub init/);
  });

  test('doctor with no config exits cleanly (no TypeError / stack)', async () => {
    const { code, stdout, stderr } = await runCli(emptyDir, ['doctor']);
    const out = `${stdout}\n${stderr}`;
    expect(code).toBe(1);
    assertCleanMissingConfig(out);
  });

  const riskyCommands = [
    ['deploy'],
    ['rollback'],
    ['verify'],
    ['build'],
    ['sync-workflows'],
    ['sync-k8s-ports'],
    ['env', 'list'],
    ['artifact', 'list'],
    ['storage', 'list'],
  ];

  test.each(riskyCommands)(
    'missing config: deployhub %s exits cleanly',
    async (...args) => {
      const { code, stdout, stderr } = await runCli(emptyDir, args.flat());
      const out = `${stdout}\n${stderr}`;
      expect(code).toBe(1);
      assertCleanMissingConfig(out);
    }
  );

  test('formatFatalCliError strips stack frames and snapshot paths', () => {
    const err = new Error('Cannot read properties of null (reading \'storage\')');
    err.stack =
      "TypeError: Cannot read properties of null (reading 'storage')\n" +
      '    at _Command.<anonymous> (C:\\snapshot\\DeployHub\\dist\\deployhub.cjs:1:1)\n' +
      '    at /snapshot/DeployHub/dist/deployhub.cjs:2:2\n';

    const formatted = formatFatalCliError(err);
    expect(formatted).toMatch(/Unexpected error:/);
    expect(formatted).toMatch(/Cannot read properties of null/);
    expect(formatted).not.toMatch(/snapshot/i);
    expect(formatted).not.toMatch(/\s+at\s+/);
    expect(formatted).not.toMatch(/deployhub\.cjs/);
  });

  test('CLI catch-all converts thrown action errors into a clean message', async () => {
    const harness = path.join(ROOT, 'tests', `.fatal-harness-${process.pid}.mjs`);
    await fs.writeFile(
      harness,
      `import { Command } from 'commander';
import { reportFatalCliError, installCliFatalHandlers } from '../src/cli/fatal-error.js';

installCliFatalHandlers();
const program = new Command();
program.command('boom').action(async () => {
  const err = new Error('simulated unexpected failure');
  err.stack = 'Error: simulated unexpected failure\\n    at x (C:\\\\snapshot\\\\DeployHub\\\\x.js:1:1)';
  throw err;
});
program.parseAsync(['node', 'h', 'boom']).catch((err) => {
  reportFatalCliError(err);
  process.exit(1);
});
`
    );

    try {
      const { code, stdout, stderr } = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [harness], {
          cwd: ROOT,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => {
          out += d.toString();
        });
        child.stderr.on('data', (d) => {
          err += d.toString();
        });
        child.on('close', (c) => resolve({ code: c ?? 1, stdout: out, stderr: err }));
        child.on('error', reject);
      });

      const combined = `${stdout}\n${stderr}`;
      expect(code).toBe(1);
      expect(combined).toMatch(/Unexpected error: simulated unexpected failure/);
      expect(combined).not.toMatch(/snapshot/i);
      expect(combined).not.toMatch(/\n\s+at\s+/);
    } finally {
      await fs.remove(harness).catch(() => {});
    }
  });
});
