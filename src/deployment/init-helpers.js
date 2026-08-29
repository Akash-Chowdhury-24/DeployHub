import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import net from 'net';
import { execa } from 'execa';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { NodeSSH } from 'node-ssh';
import { toKebabCase } from '../utils/shell-quote.js';

/** @type {Record<string, string>} */
export const OS_USER_DEFAULTS = {
  ubuntu: 'ubuntu',
  'amazon linux': 'ec2-user',
  debian: 'admin',
  centos: 'centos',
  fedora: 'fedora',
  rhel: 'ec2-user',
  windows: 'Administrator',
};

/**
 * @param {string} osHint
 * @returns {string|undefined}
 */
export function suggestSshUser(osHint) {
  if (!osHint) return undefined;
  const lower = osHint.toLowerCase();
  for (const [key, user] of Object.entries(OS_USER_DEFAULTS)) {
    if (lower.includes(key)) return user;
  }
  return undefined;
}

/**
 * Normalize the optional health-check URL from `deployhub init`.
 * Blank / whitespace → empty string. Never synthesizes localhost defaults
 * (those always fail from GitHub Actions runners, which are not the deploy target).
 *
 * @param {unknown} answer
 * @returns {string}
 */
export function normalizeInitHealthCheckUrl(answer) {
  return typeof answer === 'string' && answer.trim() ? answer.trim() : '';
}

/**
 * @param {string} keyPath
 * @returns {Promise<{ ok: boolean, message: string, fixed?: boolean }>}
 */
export async function validateSshKeyPath(keyPath) {
  const expanded = keyPath.replace(/^~/, os.homedir());
  const resolved = path.resolve(expanded);

  if (!(await fs.pathExists(resolved))) {
    return {
      ok: false,
      message: `SSH key file not found: ${resolved}`,
    };
  }

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    return { ok: false, message: `SSH_KEY_PATH is not a file: ${resolved}` };
  }

  const mode = stat.mode & 0o777;
  if (mode !== 0o400 && mode !== 0o600) {
    const { fix } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'fix',
        message: `SSH key permissions are ${mode.toString(8)} (should be 400 or 600). Fix now?`,
        default: true,
      },
    ]);
    if (fix) {
      await fs.chmod(resolved, 0o600);
      return { ok: true, message: 'Permissions fixed to 600', fixed: true };
    }
    return {
      ok: false,
      message: `SSH key permissions too open (${mode.toString(8)}). Run: chmod 600 ${resolved}`,
    };
  }

  return { ok: true, message: 'SSH key file OK' };
}

/**
 * @param {string} pem
 * @returns {boolean}
 */
function isValidPemPrivateKey(pem) {
  return pem.includes('BEGIN') && pem.includes('PRIVATE KEY');
}

/**
 * Non-interactive SSH key check for deployhub doctor.
 * @param {string} [keyPath]
 * @param {string} [sshKey]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function validateSshKeyForDoctor(keyPath, sshKey) {
  if (!keyPath && !sshKey) {
    return {
      ok: false,
      message: 'SSH_KEY_PATH (local) or SSH_KEY (CI) is required — see .env.example.',
    };
  }

  if (sshKey) {
    if (!isValidPemPrivateKey(sshKey)) {
      return {
        ok: false,
        message: 'SSH_KEY is not a valid PEM private key — must include BEGIN/END PRIVATE KEY lines.',
      };
    }
    return { ok: true, message: 'SSH_KEY PEM format looks valid' };
  }

  const expanded = keyPath.replace(/^~/, os.homedir());
  const resolved = path.resolve(expanded);

  if (!(await fs.pathExists(resolved))) {
    return {
      ok: false,
      message: `SSH key file not found at ${keyPath} — check SSH_KEY_PATH points to your private .pem/.key file.`,
    };
  }

  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    return { ok: false, message: `SSH_KEY_PATH is not a file: ${resolved}` };
  }

  const content = await fs.readFile(resolved, 'utf-8');
  if (!isValidPemPrivateKey(content)) {
    return {
      ok: false,
      message: `SSH key file at ${keyPath} is not a valid PEM private key — must include BEGIN/END PRIVATE KEY lines.`,
    };
  }

  const mode = stat.mode & 0o777;
  // Windows NTFS does not carry Unix 400/600; OpenSSH uses ACLs instead.
  // A 666 stat here is not "world-readable" the way it is on Linux.
  if (process.platform !== 'win32' && mode !== 0o400 && mode !== 0o600) {
    return {
      ok: false,
      message: `SSH key permissions are ${mode.toString(8)} (should be 400 or 600) — run: chmod 600 ${resolved}`,
    };
  }

  return { ok: true, message: `SSH key file valid (${resolved})` };
}

/**
 * TCP reachability check — independent of SSH key validity.
 * @param {string} host
 * @param {number} [port]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export function testSshHostReachability(host, port = 22, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish({
        ok: true,
        message: `TCP connection to ${host}:${port} succeeded`,
      });
    });
    socket.once('timeout', () => {
      finish({
        ok: false,
        message: `Cannot reach ${host}:${port} — connection timed out. Check SSH_HOST is correct and port ${port} is open in your security group/firewall.`,
      });
    });
    socket.once('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      finish({
        ok: false,
        message: `Cannot reach ${host}:${port} — ${msg}. Check SSH_HOST is correct and port ${port} is open in your security group/firewall.`,
      });
    });
    socket.connect(port, host);
  });
}

/**
 * @param {{ host: string, user: string, keyPath?: string, sshKey?: string, sshPort?: number }} opts
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function testSshConnectivity(opts) {
  const { host, user, keyPath, sshKey, sshPort = 22 } = opts;
  if (!host || !user) {
    return { ok: false, message: 'Host and user are required for SSH test' };
  }

  const ssh = new NodeSSH();
  /** @type {string|undefined} */
  let tmpKeyPath;

  try {
    /** @type {import('node-ssh').SSHConnectOptions} */
    const connectOpts = {
      host,
      username: user,
      port: sshPort,
      readyTimeout: 15000,
    };

    if (sshKey) {
      tmpKeyPath = path.join(os.tmpdir(), `deployhub-doctor-${Date.now()}.pem`);
      await fs.writeFile(tmpKeyPath, sshKey, { mode: 0o600 });
      connectOpts.privateKeyPath = tmpKeyPath;
    } else if (keyPath) {
      const expanded = keyPath.replace(/^~/, os.homedir());
      connectOpts.privateKeyPath = path.resolve(expanded);
    } else {
      return { ok: false, message: 'SSH_KEY_PATH or SSH_KEY is required for connectivity test' };
    }

    await ssh.connect(connectOpts);
    const result = await ssh.execCommand('echo deployhub-ok');
    if (result.stdout.trim() !== 'deployhub-ok') {
      return { ok: false, message: `Connected but remote shell test failed for ${user}@${host}:${sshPort}` };
    }
    return { ok: true, message: `SSH connection OK: ${user}@${host}:${sshPort}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Could not connect to ${user}@${host}:${sshPort} — ${msg}. Check host, user, key, and that port ${sshPort} is open in your firewall/security group.`,
    };
  } finally {
    ssh.dispose();
    if (tmpKeyPath) {
      await fs.remove(tmpKeyPath).catch(() => {});
    }
  }
}

/**
 * @returns {Promise<string[]>}
 */
export async function listKubeContexts() {
  try {
    const { stdout } = await execa('kubectl', ['config', 'get-contexts', '-o', 'name'], {
      stdio: 'pipe',
    });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @returns {Promise<string|undefined>}
 */
export async function detectKubeconfigPath() {
  const defaultPath = path.join(os.homedir(), '.kube', 'config');
  if (await fs.pathExists(defaultPath)) {
    return defaultPath;
  }
  return undefined;
}

/**
 * @returns {Promise<string|undefined>}
 */
export async function detectAzureSubscriptionId() {
  try {
    const { stdout } = await execa(
      'az',
      ['account', 'show', '--query', 'id', '-o', 'tsv'],
      { stdio: 'pipe' }
    );
    const id = stdout.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * @returns {Promise<string|undefined>}
 */
export async function detectGcpProjectId() {
  try {
    const { stdout } = await execa(
      'gcloud',
      ['config', 'get-value', 'project'],
      { stdio: 'pipe' }
    );
    const id = stdout.trim();
    if (id && id !== '(unset)') return id;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * @param {string} [kubeconfig]
 * @param {string} [context]
 */
export async function testKubeConnectivity(kubeconfig, context) {
  /** @type {string[]} */
  const args = ['cluster-info'];
  const env = { ...process.env };

  if (kubeconfig) {
    const expanded = kubeconfig.replace(/^~/, os.homedir());
    env.KUBECONFIG = path.resolve(expanded);
  }
  if (context) {
    args.push('--context', context);
  }

  try {
    await execa('kubectl', args, { stdio: 'pipe', env });
    return { ok: true, message: `kubectl cluster-info OK${context ? ` (context: ${context})` : ''}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `kubectl cluster-info failed — ${msg}. Check KUBECONFIG path and KUBE_CONTEXT name.`,
    };
  }
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {Promise<string>}
 */
export async function confirmValueIfContainsSpaces(value, label) {
  if (!/\s/.test(value)) return value;

  const suggested = toKebabCase(value);
  console.log(chalk.yellow(`\n  ⚠ Your ${label} contains spaces: "${value}"`));
  console.log(
    chalk.gray(
      `  Spaces in paths can cause shell issues on the server. Suggested: "${suggested || value.replace(/\s+/g, '-')}"`
    )
  );

  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: 'How would you like to proceed?',
      choices: [
        {
          name: `Use suggested: ${suggested || value.replace(/\s+/g, '-')}`,
          value: 'suggested',
        },
        { name: `Keep original: ${value}`, value: 'keep' },
        { name: 'Enter a different value', value: 'custom' },
      ],
    },
  ]);

  if (choice === 'suggested') {
    return suggested || value.replace(/\s+/g, '-');
  }
  if (choice === 'keep') {
    return value;
  }

  const { custom } = await inquirer.prompt([
    {
      type: 'input',
      name: 'custom',
      message: `${label}:`,
      default: suggested || value.replace(/\s+/g, '-'),
    },
  ]);
  return custom;
}

/**
 * @param {Record<string, string>} sshAnswers
 * @param {'frontend'|'backend'|'both'} projectType
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveDeployPathsWithSpaceWarning(sshAnswers, projectType) {
  if (projectType !== 'both' && sshAnswers.deployPath) {
    sshAnswers.deployPath = await confirmValueIfContainsSpaces(
      sshAnswers.deployPath,
      'deploy path'
    );
  }

  if (projectType === 'both') {
    if (sshAnswers.frontendDeployPath) {
      sshAnswers.frontendDeployPath = await confirmValueIfContainsSpaces(
        sshAnswers.frontendDeployPath,
        'frontend deploy path'
      );
    }
    if (sshAnswers.backendDeployPath) {
      sshAnswers.backendDeployPath = await confirmValueIfContainsSpaces(
        sshAnswers.backendDeployPath,
        'backend deploy path'
      );
    }
  }

  return sshAnswers;
}

/**
 * Run SSH key validation + connectivity test after init prompts.
 * @param {{ host: string, user: string, keyPath?: string, sshPort?: number, deployType: string }} opts
 */
export async function runSshInitValidation(opts) {
  const { host, user, keyPath, sshPort = 22, deployType } = opts;

  if (keyPath) {
    console.log(chalk.gray('\n  Validating SSH key...'));
    const keyResult = await validateSshKeyPath(keyPath);
    if (!keyResult.ok) {
      console.log(chalk.red(`  ✗ ${keyResult.message}`));
      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue without a valid SSH key? (you can fix .env later)',
          default: false,
        },
      ]);
      if (!continueAnyway) {
        throw new Error('Init cancelled — fix SSH key path and run deployhub init again.');
      }
    } else {
      console.log(chalk.green(`  ✓ ${keyResult.message}`));
    }
  }

  if (host && user && keyPath) {
    console.log(chalk.gray(`  Testing SSH connection to ${deployType} target...`));
    const connResult = await testSshConnectivity({ host, user, keyPath, sshPort });
    if (connResult.ok) {
      console.log(chalk.green(`  ✓ ${connResult.message}`));
    } else {
      console.log(chalk.yellow(`  ⚠ ${connResult.message}`));
      console.log(
        chalk.gray(
          '  (Connection test failed — you can fix firewall/credentials and run deployhub doctor later.)'
        )
      );
    }
  }
}

/**
 * @param {string} deployType
 */
export function getDeployTypeLabel(deployType) {
  const labels = {
    ssh: 'SSH (any Linux server)',
    docker: 'Docker (local or remote daemon)',
    ec2: 'AWS EC2 (SSH to instance)',
    'azure-vm': 'Azure VM (SSH to virtual machine)',
    'gcp-vm': 'GCP Compute Engine VM (SSH)',
    kubernetes: 'Kubernetes (existing cluster)',
  };
  return labels[deployType] || deployType;
}
