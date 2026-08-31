/**
 * Multi-environment helpers — kept separate from config I/O to avoid ESM cycles
 * (e.g. github-actions ↔ config via doctor/sync-workflows).
 */

/** DNS label / Kubernetes namespace max length — tightest downstream constraint. */
export const ENV_NAME_MAX_LENGTH = 63;

/**
 * Reserved CLI sentinel names. `"all"` collides with `--env all`.
 * `"default"` is intentionally NOT reserved — it is a normal env key used by
 * single-env init and legacy migration, with no special CLI meaning.
 */
export const RESERVED_ENVIRONMENT_NAMES = new Set(['all']);

/**
 * Lowercase kebab-case: safe for storage paths, CI secret prefixes (uppercased),
 * and Nginx site filename segments.
 */
export const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Validate a candidate environment name before writing config.
 * Shared by `deployhub env add` and interactive init / env-name prompts.
 *
 * @param {string} name
 * @param {Iterable<string>} [existingNames]
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateEnvironmentName(name, existingNames = []) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'Environment name cannot be empty.' };
  }
  if (trimmed.length > ENV_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Environment name must be at most ${ENV_NAME_MAX_LENGTH} characters.`,
    };
  }
  if (RESERVED_ENVIRONMENT_NAMES.has(trimmed.toLowerCase())) {
    return {
      ok: false,
      error: `"${trimmed}" is a reserved name and cannot be used as an environment name.`,
    };
  }
  if (!ENV_NAME_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: `Invalid environment name "${trimmed}". Use lowercase letters, numbers, and hyphens only (must start with a letter), e.g. production, staging, my-app.`,
    };
  }
  const existing = [...existingNames];
  const collision = existing.find((n) => String(n).toLowerCase() === trimmed.toLowerCase());
  if (collision) {
    return {
      ok: false,
      error: `Environment "${collision}" already exists (names are case-insensitive). Use a different name or remove it first.`,
    };
  }
  return { ok: true, name: trimmed };
}

/**
 * Inquirer `validate` callback for environment name prompts.
 *
 * @param {Iterable<string>} [existingNames]
 * @returns {(input: string) => true|string}
 */
export function createEnvNamePromptValidate(existingNames = []) {
  return (input) => {
    const result = validateEnvironmentName(input, existingNames);
    return result.ok ? true : result.error;
  };
}

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isNewEnvironmentShape(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof /** @type {Record<string, unknown>} */ (entry).method === 'string' &&
      /** @type {Record<string, unknown>} */ (entry).config &&
      typeof /** @type {Record<string, unknown>} */ (entry).config === 'object' &&
      !Array.isArray(/** @type {Record<string, unknown>} */ (entry).config)
  );
}

/**
 * @param {unknown} envEntry
 * @returns {string|undefined}
 */
export function getEnvMethod(envEntry) {
  if (!envEntry || typeof envEntry !== 'object') return undefined;
  const e = /** @type {Record<string, unknown>} */ (envEntry);
  if (typeof e.method === 'string') return e.method;
  if (typeof e.type === 'string') return e.type;
  return undefined;
}

/**
 * Method-specific settings object (mutable reference for new-shape `config`).
 * Supports legacy flat env entries used in tests.
 *
 * @param {unknown} envEntry
 * @returns {Record<string, unknown>}
 */
export function getEnvSettings(envEntry) {
  if (!envEntry || typeof envEntry !== 'object') return {};
  if (isNewEnvironmentShape(envEntry)) {
    return /** @type {Record<string, unknown>} */ (
      /** @type {Record<string, unknown>} */ (envEntry).config
    );
  }
  return /** @type {Record<string, unknown>} */ (envEntry);
}

/**
 * @param {unknown} envEntry
 * @returns {boolean}
 */
export function isEnvEnabled(envEntry) {
  if (!envEntry || typeof envEntry !== 'object') return false;
  const e = /** @type {Record<string, unknown>} */ (envEntry);
  if (typeof e.enabled === 'boolean') return e.enabled;
  return true;
}

/**
 * @param {unknown} envEntry
 * @returns {'push'|'manual'}
 */
export function getEnvTrigger(envEntry) {
  if (!envEntry || typeof envEntry !== 'object') return 'manual';
  const e = /** @type {Record<string, unknown>} */ (envEntry);
  return e.trigger === 'push' ? 'push' : 'manual';
}

/**
 * Normalize a git branch name from config / prompts.
 * Strips a leading `refs/heads/` if the user pasted a full ref.
 *
 * @param {unknown} input
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function normalizeGitBranchName(input) {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'Branch name cannot be empty.' };
  }
  const stripped = trimmed.replace(/^refs\/heads\//, '');
  if (!stripped) {
    return { ok: false, error: 'Branch name cannot be empty.' };
  }
  if (/\s/.test(stripped)) {
    return { ok: false, error: 'Branch name cannot contain whitespace.' };
  }
  return { ok: true, name: stripped };
}

/**
 * @param {unknown} envEntry
 * @returns {string|null}
 */
export function getEnvBranch(envEntry) {
  if (!envEntry || typeof envEntry !== 'object') return null;
  const parsed = normalizeGitBranchName(
    /** @type {Record<string, unknown>} */ (envEntry).branch
  );
  return parsed.ok ? parsed.name : null;
}

/**
 * True when at least one environment has opted into `branch` mapping.
 * Absence of every `branch` field = grandfathered main-only push trigger.
 *
 * @param {Record<string, unknown>} [config]
 * @returns {boolean}
 */
export function configHasBranchMapping(config) {
  const envs = /** @type {Record<string, unknown>} */ (config?.environments || {});
  return Object.values(envs).some((entry) => getEnvBranch(entry) != null);
}

/**
 * Current git branch for a GitHub Actions push run.
 * Tags and missing refs return null (no environment matches).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function resolvePushBranchName(env = process.env) {
  const ref = env.GITHUB_REF;
  if (typeof ref === 'string' && ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length) || null;
  }
  // Some harnesses set GITHUB_REF_NAME without GITHUB_REF.
  if (typeof env.GITHUB_REF_NAME === 'string' && env.GITHUB_REF_NAME.trim()) {
    if (typeof ref === 'string' && ref.startsWith('refs/tags/')) return null;
    return env.GITHUB_REF_NAME.trim();
  }
  return null;
}

/**
 * Unique `on.push.branches` list for the generated workflow.
 *
 * - No environment has `branch` → `['main']` (today's hardcoded trigger).
 * - Otherwise: unique branches of enabled `trigger: push` environments
 *   (an enabled push env without `branch` defaults to `main`).
 *   `main` is listed first when present. Empty if nothing should auto-trigger.
 *
 * @param {Record<string, unknown>} [config]
 * @returns {string[]}
 */
export function getWorkflowPushBranches(config) {
  const envs = /** @type {Record<string, unknown>} */ (config?.environments || {});
  if (!configHasBranchMapping(config || {})) {
    return ['main'];
  }

  /** @type {string[]} */
  const collected = [];
  const seen = new Set();
  for (const entry of Object.values(envs)) {
    if (!isEnvEnabled(entry) || getEnvTrigger(entry) !== 'push') continue;
    const branch = getEnvBranch(entry) || 'main';
    if (seen.has(branch)) continue;
    seen.add(branch);
    collected.push(branch);
  }

  if (collected.includes('main')) {
    return ['main', ...collected.filter((b) => b !== 'main')];
  }
  return collected;
}

/**
 * Init / doctor copy. The second line makes the exclusion explicit.
 *
 * @param {string[]} branches
 * @returns {string}
 */
export function formatBranchMappingSummary(branches) {
  const list = branches.length > 0 ? branches.join(', ') : '(none)';
  return [
    `Branches mapped to an environment: ${list}`,
    'Pushes to any other branch will not trigger DeployHub.',
  ].join('\n');
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string|null}
 */
export function resolveDefaultEnvironmentName(config) {
  const envs = /** @type {Record<string, unknown>} */ (config.environments || {});
  const named = config.defaultEnvironment;
  if (typeof named === 'string' && envs[named]) return named;

  const deploy = /** @type {string[]|undefined} */ (config.deploy);
  if (Array.isArray(deploy) && deploy[0] && envs[deploy[0]]) return deploy[0];

  const enabled = Object.entries(envs)
    .filter(([, e]) => isEnvEnabled(e))
    .map(([n]) => n);
  if (enabled.length === 1) return enabled[0];
  if (envs.default) return 'default';
  if (envs.production) return 'production';
  return enabled[0] || Object.keys(envs)[0] || null;
}

/**
 * Enabled environment names — **the single source of truth** for “which envs
 * apply” across CLI, pipeline gating, workflow secret injection, and dropdowns.
 * Do not add a parallel helper that re-filters `environments` by `enabled`
 * (that shape caused Build/Dispatch secret asymmetry when lists drifted).
 *
 * Falls back to legacy `deploy[]` when present and environments lack `enabled`.
 * Used for `--env all` and pipeline defaults.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
export function getEnabledEnvironmentNames(config) {
  const envs = /** @type {Record<string, unknown>} */ (config.environments || {});
  const names = Object.keys(envs);
  if (names.length === 0) return [];

  const hasEnabledFlag = names.some(
    (n) => typeof /** @type {Record<string, unknown>} */ (envs[n])?.enabled === 'boolean'
  );
  if (hasEnabledFlag || names.some((n) => isNewEnvironmentShape(envs[n]))) {
    return names.filter((n) => isEnvEnabled(envs[n]));
  }

  const deploy = /** @type {string[]|undefined} */ (config.deploy);
  if (Array.isArray(deploy) && deploy.length > 0) {
    return deploy.filter((n) => Boolean(envs[n]));
  }
  return names;
}

/**
 * Build a new-shape environment entry from method + settings.
 *
 * @param {string} method
 * @param {Record<string, unknown>} [settings]
 * @param {{ enabled?: boolean, trigger?: 'push'|'manual', branch?: string }} [meta]
 */
export function buildEnvironmentEntry(method, settings = {}, meta = {}) {
  const cleaned = { ...settings };
  delete cleaned.type;
  delete cleaned.method;
  delete cleaned.enabled;
  delete cleaned.trigger;
  delete cleaned.branch;
  delete cleaned.config;
  const trigger = meta.trigger === 'push' ? 'push' : 'manual';
  const branchParsed =
    trigger === 'push' && meta.branch != null ? normalizeGitBranchName(meta.branch) : null;
  return {
    enabled: meta.enabled !== false,
    method,
    trigger,
    ...(branchParsed?.ok ? { branch: branchParsed.name } : {}),
    config: cleaned,
  };
}

/**
 * Resolve which environments a deploy/rollback should target.
 *
 * @param {Record<string, unknown>} config
 * @param {string|undefined} envFlag — omitted = default only; `"all"` = every enabled; else one name
 * @returns {{ targets: string[], skippedDisabled: string[] }}
 */
export function resolveEnvTargets(config, envFlag) {
  const envs = /** @type {Record<string, unknown>} */ (config.environments || {});

  if (!envFlag) {
    const def = resolveDefaultEnvironmentName(config);
    if (!def) {
      throw new Error(
        'No environments configured. Run "deployhub init" or "deployhub env add <name>".'
      );
    }
    if (!isEnvEnabled(envs[def])) {
      throw new Error(
        `Environment "${def}" is disabled. Enable it with: deployhub env enable ${def}`
      );
    }
    return { targets: [def], skippedDisabled: [] };
  }

  if (envFlag === 'all') {
    /** @type {string[]} */
    const skippedDisabled = [];
    /** @type {string[]} */
    const targets = [];
    for (const name of Object.keys(envs)) {
      if (isEnvEnabled(envs[name])) {
        targets.push(name);
      } else {
        skippedDisabled.push(name);
      }
    }
    return { targets, skippedDisabled };
  }

  if (!envs[envFlag]) {
    throw new Error(
      `Environment "${envFlag}" not found in config. Use: deployhub env list`
    );
  }
  if (!isEnvEnabled(envs[envFlag])) {
    throw new Error(
      `Environment "${envFlag}" is disabled. Enable it with: deployhub env enable ${envFlag}`
    );
  }
  return { targets: [envFlag], skippedDisabled: [] };
}

/**
 * Whitelist of method-config fields copied onto process env for Docker and
 * Kubernetes providers. Structural (not a per-method if): only these keys are
 * ever copied. `remote` / `host` / `user` / `keyPath` are intentionally absent
 * — docker SSH identity is read by docker.js from settings + SSH_* env vars.
 * Kubernetes uses this same helper and therefore cannot observe remote.mode.
 */
export const METHOD_SETTINGS_ENV_OVERLAY = Object.freeze({
  dockerImageName: 'DOCKER_IMAGE_NAME',
  dockerRegistryUrl: 'DOCKER_REGISTRY_URL',
  dockerHost: 'DOCKER_HOST',
  kubeNamespace: 'KUBE_NAMESPACE',
  kubeconfig: 'KUBECONFIG',
  kubeContext: 'KUBE_CONTEXT',
});

/**
 * Overlay method-specific config onto process env for Docker/K8s providers.
 * Secrets still come from real env vars; non-secret names/paths come from config.
 *
 * @param {Record<string, string|undefined>} env
 * @param {Record<string, unknown>} settings
 * @returns {Record<string, string|undefined>}
 */
export function mergeMethodSettingsIntoEnv(env, settings) {
  /** @type {Record<string, string|undefined>} */
  const out = { ...env };
  for (const [settingKey, envKey] of Object.entries(METHOD_SETTINGS_ENV_OVERLAY)) {
    const value = settings[settingKey];
    if (value) out[envKey] = String(value);
  }
  return out;
}

export default {
  ENV_NAME_MAX_LENGTH,
  RESERVED_ENVIRONMENT_NAMES,
  ENV_NAME_PATTERN,
  validateEnvironmentName,
  createEnvNamePromptValidate,
  isNewEnvironmentShape,
  getEnvMethod,
  getEnvSettings,
  isEnvEnabled,
  getEnvTrigger,
  normalizeGitBranchName,
  getEnvBranch,
  configHasBranchMapping,
  resolvePushBranchName,
  getWorkflowPushBranches,
  formatBranchMappingSummary,
  resolveDefaultEnvironmentName,
  getEnabledEnvironmentNames,
  buildEnvironmentEntry,
  resolveEnvTargets,
  mergeMethodSettingsIntoEnv,
  METHOD_SETTINGS_ENV_OVERLAY,
};
