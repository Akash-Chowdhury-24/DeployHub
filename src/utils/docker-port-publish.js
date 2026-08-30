import { execa } from 'execa';
import { getEnvMethod, getEnvSettings } from '../core/environments.js';
import { resolveDockerContainerName } from './docker-container-name.js';
import { resolveDockerRemoteMode } from './docker-remote-mode.js';
import { resolveDockerSshTarget } from './docker-remote.js';
import { createSshExecSession } from '../deployment/ssh-connection.js';
import { shellQuote } from './shell-quote.js';

/** Go template: running|bindings. Empty HostIp treated as 0.0.0.0. */
export const DOCKER_INSPECT_PORT_FORMAT =
  `{{if .State.Running}}running{{else}}stopped{{end}}|` +
  `{{range $p, $conf := .NetworkSettings.Ports}}` +
  `{{range $conf}}` +
  `{{if eq .HostIp ""}}0.0.0.0{{else}}{{.HostIp}}{{end}}:{{.HostPort}}->` +
  `{{end}}{{end}}`;

export const DOCKER_PORT_NOT_PUBLISHED_TRAILER =
  'The app is not reachable from outside the container.';

/**
 * Exact doctor/verify failure copy when a container is running without `-p`.
 * @param {string} containerName
 * @param {number} port
 */
export function formatDockerPortNotPublished(containerName, port) {
  return (
    `Container '${containerName}' is running but port ${port} is not published ` +
    `on the host (no 0.0.0.0:${port}-> mapping).\n` +
    DOCKER_PORT_NOT_PUBLISHED_TRAILER
  );
}

/**
 * @param {string} containerName
 * @param {number} port
 */
export function formatDockerPortPublished(containerName, port) {
  return `Container '${containerName}' publishes 0.0.0.0:${port}->`;
}

/**
 * @param {string} envName
 */
export function formatDockerSshPortRequired(envName) {
  return (
    `Docker remote.mode "ssh" requires a published port. ` +
    `Set environments.${envName}.config.port (or top-level port) so the container ` +
    `is started with -p <port>:<port>. Deploying without -p leaves the app unreachable.`
  );
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function parsePublishPort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * Top-level `config.port` is the legacy single-env fallback (scenario 2A).
 * With two or more docker environments it must not be inherited by a later
 * env that never stored its own `config.port` — that would silently publish
 * another environment's port.
 *
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {string} [envName]
 */
function shouldUseTopLevelDockerPortFallback(config = {}, envName) {
  const dockerNames = Object.entries(config.environments || {})
    .filter(([, entry]) => getEnvMethod(entry) === 'docker')
    .map(([name]) => name);

  if (dockerNames.length <= 1) return true;
  if (!envName) return false;

  if (config.defaultEnvironment && dockerNames.includes(config.defaultEnvironment)) {
    return envName === config.defaultEnvironment;
  }
  if (
    config.unprefixedSecretEnvironment &&
    dockerNames.includes(config.unprefixedSecretEnvironment)
  ) {
    return envName === config.unprefixedSecretEnvironment;
  }
  return false;
}

/**
 * Configured host/container publish port. No silent default — missing means
 * SSH must fail loudly instead of running unpublished.
 *
 * Fallback chain is still `settings.port ?? config.port` (plus `backend.port`)
 * for legacy single-env configs and the original docker env. It is not used
 * for additional docker environments that omitted `config.port`.
 *
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {Record<string, unknown>} [settings]
 * @param {string} [envName]
 * @returns {number|null}
 */
export function resolveDockerPublishPort(config = {}, settings = {}, envName) {
  const own = parsePublishPort(settings.port);
  if (own != null) return own;
  if (!shouldUseTopLevelDockerPortFallback(config, envName)) return null;
  return parsePublishPort(config.port ?? config.backend?.port);
}

/**
 * @param {string} stdout
 * @param {number} port
 */
export function inspectShowsHostPortMapping(stdout, port) {
  return String(stdout || '').includes(`0.0.0.0:${port}->`);
}

/**
 * @param {string} containerName
 */
export function buildDockerInspectPortsArgs(containerName) {
  return ['inspect', '--format', DOCKER_INSPECT_PORT_FORMAT, containerName];
}

/**
 * @param {string} containerName
 */
export function buildDockerInspectPortsCommand(containerName) {
  const args = buildDockerInspectPortsArgs(containerName);
  return `docker inspect --format ${shellQuote(args[2])} ${shellQuote(containerName)}`;
}

/**
 * @param {{ code?: number|null, stdout?: string, stderr?: string }} result
 * @param {{ containerName: string, port: number, requireRunning: boolean }} opts
 * @returns {{ pass: boolean, reason: 'published'|'not-running'|'unpublished'|'missing-container', message: string }}
 */
export function evaluateDockerPortPublish(result, opts) {
  const { containerName, port, requireRunning } = opts;
  const code = result.code;
  const raw = String(result.stdout || '');
  let running = true;
  let mappings = raw;
  const pipe = raw.indexOf('|');
  if (pipe >= 0 && (raw.startsWith('running|') || raw.startsWith('stopped|'))) {
    running = raw.startsWith('running|');
    mappings = raw.slice(pipe + 1);
  }

  if ((code !== 0 && code !== null && code !== undefined) || !running) {
    if (!requireRunning) {
      return {
        pass: true,
        reason: 'not-running',
        message: `No running container '${containerName}' — deploy first, then re-run this check.`,
      };
    }
    if (!running && (code === 0 || code === null || code === undefined)) {
      return {
        pass: false,
        reason: 'missing-container',
        message:
          `Container '${containerName}' is not running — cannot confirm port ${port} is published.`,
      };
    }
    return {
      pass: false,
      reason: 'missing-container',
      message:
        `Container '${containerName}' is not running — cannot confirm port ${port} is published.`,
    };
  }

  if (inspectShowsHostPortMapping(mappings, port)) {
    return {
      pass: true,
      reason: 'published',
      message: formatDockerPortPublished(containerName, port),
    };
  }

  return {
    pass: false,
    reason: 'unpublished',
    message: formatDockerPortNotPublished(containerName, port),
  };
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string[]} envNames
 */
export function anyDockerEnvHasPublishPort(config, envNames) {
  return (envNames || []).some((envName) => {
    const entry = config.environments?.[envName];
    if (getEnvMethod(entry) !== 'docker') return false;
    const settings = getEnvSettings(entry);
    return resolveDockerPublishPort(config, settings, envName) != null;
  });
}

/**
 * Whether the post-deploy verify stage should run (HTTP health and/or docker port).
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string[]} envNames
 * @param {(config: import('../core/config.js').DeployHubConfig, envNames: string[]) => boolean} hasHealthUrl
 */
export function verifyStageShouldRun(config, envNames, hasHealthUrl) {
  return Boolean(hasHealthUrl(config, envNames) || anyDockerEnvHasPublishPort(config, envNames));
}

/**
 * Inspect one docker environment's running container for 0.0.0.0:<port>->.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {{ requireRunning?: boolean, env?: Record<string, string|undefined> }} [options]
 */
export async function checkEnvDockerPortPublish(config, envName, options = {}) {
  const entry = config.environments?.[envName];
  const method = getEnvMethod(entry);
  if (method !== 'docker') {
    return { skipped: true, envName, pass: true, message: '' };
  }

  const settings = getEnvSettings(entry);
  const env = options.env || process.env;
  const requireRunning = options.requireRunning !== false;
  const port = resolveDockerPublishPort(config, settings, envName);
  const remoteMode = resolveDockerRemoteMode(settings, env);
  const containerName = resolveDockerContainerName(config, envName);

  if (port == null) {
    if (remoteMode === 'ssh') {
      return {
        skipped: false,
        envName,
        pass: false,
        message: formatDockerSshPortRequired(envName),
      };
    }
    return { skipped: true, envName, pass: true, message: '' };
  }

  /** @type {{ code?: number|null, stdout?: string, stderr?: string }} */
  let result;
  if (remoteMode === 'ssh') {
    const target = resolveDockerSshTarget(settings, env);
    const session = createSshExecSession({
      ...target,
      keyPath: target.keyPath ? String(target.keyPath) : undefined,
      env,
    });
    const ssh = await session.connect();
    try {
      result = await session.execUnchecked(ssh, buildDockerInspectPortsCommand(containerName));
    } finally {
      ssh.dispose();
    }
  } else {
    try {
      const inspected = await execa('docker', buildDockerInspectPortsArgs(containerName), {
        stdio: 'pipe',
        env: { ...process.env, ...env },
      });
      result = { code: 0, stdout: inspected.stdout, stderr: inspected.stderr };
    } catch (err) {
      const execErr = /** @type {{ exitCode?: number, stdout?: string, stderr?: string }} */ (err);
      result = {
        code: execErr.exitCode ?? 1,
        stdout: execErr.stdout || '',
        stderr: execErr.stderr || (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  const verdict = evaluateDockerPortPublish(result, {
    containerName,
    port,
    requireRunning,
  });
  return {
    skipped: false,
    envName,
    pass: verdict.pass,
    message: verdict.message,
    reason: verdict.reason,
  };
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string[]} envNames
 * @param {{ requireRunning?: boolean, env?: Record<string, string|undefined> }} [options]
 */
export async function runDockerPortPublishChecksForEnvs(config, envNames, options = {}) {
  /** @type {{ envName: string, message: string }[]} */
  const results = [];
  /** @type {{ envName: string, error: string }[]} */
  const failures = [];

  for (const envName of envNames || []) {
    const outcome = await checkEnvDockerPortPublish(config, envName, options);
    if (outcome.skipped) continue;
    if (outcome.pass) {
      results.push({ envName: outcome.envName, message: outcome.message });
    } else {
      failures.push({ envName: outcome.envName, error: outcome.message });
    }
  }

  return { results, failures };
}

export default {
  DOCKER_INSPECT_PORT_FORMAT,
  formatDockerPortNotPublished,
  formatDockerPortPublished,
  formatDockerSshPortRequired,
  resolveDockerPublishPort,
  inspectShowsHostPortMapping,
  evaluateDockerPortPublish,
  anyDockerEnvHasPublishPort,
  verifyStageShouldRun,
  checkEnvDockerPortPublish,
  runDockerPortPublishChecksForEnvs,
};
