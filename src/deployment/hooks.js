/**
 * Per-environment remote shell hooks (preDeploy / postDeploy / rollback).
 * One implementation for ssh, ec2, azure-vm, gcp-vm, and docker remote.mode ssh.
 * Callers must pass the deploy's existing SSH session — do not connect again.
 */

import { createLogger } from '../logger/index.js';
import { formatRemoteCommandFailure } from '../utils/shell-quote.js';
import { getEnvMethod, getEnvSettings } from '../core/environments.js';
import { resolveDockerRemoteMode } from '../utils/docker-remote-mode.js';

/** @typedef {'preDeploy'|'postDeploy'|'rollback'} HookStage */

/** @type {HookStage[]} */
export const HOOK_STAGES = ['preDeploy', 'postDeploy', 'rollback'];

const SSH_BASED_METHODS = new Set(['ssh', 'ec2', 'azure-vm', 'gcp-vm']);

/**
 * @param {unknown} command
 * @returns {boolean}
 */
export function commandLooksSensitive(command) {
  const c = String(command || '');
  if (/(?:^|\s)(--password|--passwd|--secret|--token|--api-key)(?:=|\s+)\S+/i.test(c)) {
    return true;
  }
  // `-p secret` but not `-p 22` (SSH port) or `-p22`.
  if (/(?:^|\s)-p\s+(?!-)(?!\d+\b)\S+/.test(c)) {
    return true;
  }
  if (/(?:PASSWORD|SECRET_ACCESS_KEY|SECRET|TOKEN|API_KEY)\s*=\s*\S+/i.test(c)) {
    return true;
  }
  return false;
}

/**
 * @param {string} command
 * @returns {string}
 */
export function formatHookCommandForLog(command) {
  if (commandLooksSensitive(command)) {
    return '<command withheld — possible credential in hook string>';
  }
  return command;
}

/**
 * @param {unknown} raw
 * @returns {{ command: string, continueOnError: boolean, timeoutMs?: number }[]}
 */
function normalizeHookList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {{ command: string, continueOnError: boolean, timeoutMs?: number }[]} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const command = /** @type {Record<string, unknown>} */ (item).command;
    if (typeof command !== 'string' || !command.trim()) continue;
    const timeoutRaw = /** @type {Record<string, unknown>} */ (item).timeoutMs;
    const timeoutMs =
      typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? timeoutRaw
        : undefined;
    out.push({
      command: command.trim(),
      continueOnError: /** @type {Record<string, unknown>} */ (item).continueOnError === true,
      ...(timeoutMs != null ? { timeoutMs } : {}),
    });
  }
  return out;
}

/**
 * @param {Record<string, unknown>} [settings]
 * @returns {{ preDeploy: ReturnType<typeof normalizeHookList>, postDeploy: ReturnType<typeof normalizeHookList>, rollback: ReturnType<typeof normalizeHookList> }}
 */
export function getEnvHooks(settings = {}) {
  const raw = settings.hooks;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { preDeploy: [], postDeploy: [], rollback: [] };
  }
  const h = /** @type {Record<string, unknown>} */ (raw);
  return {
    preDeploy: normalizeHookList(h.preDeploy),
    postDeploy: normalizeHookList(h.postDeploy),
    rollback: normalizeHookList(h.rollback),
  };
}

/**
 * @param {Record<string, unknown>} [settings]
 * @returns {boolean}
 */
export function envHasAnyHooks(settings = {}) {
  const h = getEnvHooks(settings);
  return h.preDeploy.length + h.postDeploy.length + h.rollback.length > 0;
}

/**
 * @param {string|undefined} method
 * @param {Record<string, unknown>} [settings]
 * @returns {boolean}
 */
export function hooksSupportedForMethod(method, settings = {}) {
  if (SSH_BASED_METHODS.has(String(method || ''))) return true;
  if (method === 'docker') {
    return resolveDockerRemoteMode(settings) === 'ssh';
  }
  return false;
}

/**
 * Throw if hooks are configured on a method that cannot run them.
 * No-op when no hooks are set (additive — existing deploys unchanged).
 *
 * @param {string|undefined} method
 * @param {Record<string, unknown>} [settings]
 * @param {string} [envName]
 */
export function assertHooksAllowed(method, settings = {}, envName = 'this environment') {
  if (!envHasAnyHooks(settings)) return;
  if (hooksSupportedForMethod(method, settings)) return;

  let why;
  if (method === 'kubernetes') {
    why =
      'Kubernetes deploys via kubectl, not a persistent remote SSH session.';
  } else if (method === 'docker') {
    why =
      `Docker remote.mode "${resolveDockerRemoteMode(settings)}" has no DeployHub-managed SSH session (hooks require remote.mode "ssh").`;
  } else {
    why = `Method "${method}" does not support remote shell hooks.`;
  }
  throw new Error(
    `Hooks are configured for environment "${envName}" but are not supported: ${why} ` +
      `Remove environments.${envName}.config.hooks or use ssh / ec2 / azure-vm / gcp-vm / docker (remote.mode ssh).`
  );
}

/**
 * Run one hook stage on an already-open SSH session.
 *
 * @param {{
 *   session: { execUnchecked: Function, defaultExecTimeoutMs: number },
 *   ssh: unknown,
 *   settings: Record<string, unknown>,
 *   stage: HookStage,
 * }} opts
 */
export async function runDeployHooks(opts) {
  const { session, ssh, settings, stage } = opts;
  const list = getEnvHooks(settings)[stage] || [];
  if (list.length === 0) return;

  const log = createLogger(`hook:${stage}`);
  for (const hook of list) {
    const timeoutMs = hook.timeoutMs ?? session.defaultExecTimeoutMs;
    log.info(`$ ${formatHookCommandForLog(hook.command)}`);

    /** @type {{ code?: number|null, stdout?: string, stderr?: string }} */
    let result;
    try {
      result = await session.execUnchecked(ssh, hook.command, {
        timeoutMs,
        logCommand: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = /timed out after/i.test(msg);
      const wrapped = timedOut
        ? `${stage} hook timed out after ${timeoutMs}ms`
        : `${stage} hook failed: ${msg}`;
      if (hook.continueOnError) {
        log.warn(wrapped);
        continue;
      }
      log.error(wrapped);
      throw new Error(wrapped);
    }

    const out = String(result.stdout || '').trim();
    if (out) {
      for (const line of out.split(/\r?\n/)) {
        log.info(line);
      }
    }

    if (result.code !== 0 && result.code !== null && result.code !== undefined) {
      const failure = formatRemoteCommandFailure(
        hook.command,
        result.code,
        result.stderr,
        result.stdout
      );
      const wrapped = `${stage} hook failed: ${failure}`;
      if (hook.continueOnError) {
        log.warn(wrapped);
        continue;
      }
      log.error(wrapped);
      throw new Error(wrapped);
    }
  }
}

/**
 * Informational doctor lines — pass: true, never blocks.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ name: string, pass: boolean, message: string }[]}
 */
export function getHooksDoctorChecks(config) {
  const envs = /** @type {Record<string, unknown>} */ (config.environments || {});
  /** @type {{ name: string, pass: boolean, message: string }[]} */
  const checks = [];
  for (const [name, entry] of Object.entries(envs)) {
    const settings = getEnvSettings(entry);
    if (!envHasAnyHooks(settings)) continue;
    const h = getEnvHooks(settings);
    const parts = [];
    if (h.preDeploy.length) parts.push(`${h.preDeploy.length} preDeploy`);
    if (h.postDeploy.length) parts.push(`${h.postDeploy.length} postDeploy`);
    if (h.rollback.length) parts.push(`${h.rollback.length} rollback`);
    const method = getEnvMethod(entry);
    const supported = hooksSupportedForMethod(method, settings);
    checks.push({
      name: `Hooks (${name})`,
      pass: true,
      message: supported
        ? `Hooks configured for '${name}': ${parts.join(', ')}`
        : `Hooks configured for '${name}' (${parts.join(', ')}) but ${method} does not run them — remove config.hooks or use an SSH-based method`,
    });
  }
  return checks;
}

export default {
  HOOK_STAGES,
  commandLooksSensitive,
  formatHookCommandForLog,
  getEnvHooks,
  envHasAnyHooks,
  hooksSupportedForMethod,
  assertHooksAllowed,
  runDeployHooks,
  getHooksDoctorChecks,
};
