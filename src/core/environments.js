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
 * @param {{ enabled?: boolean, trigger?: 'push'|'manual' }} [meta]
 */
export function buildEnvironmentEntry(method, settings = {}, meta = {}) {
  const cleaned = { ...settings };
  delete cleaned.type;
  delete cleaned.method;
  delete cleaned.enabled;
  delete cleaned.trigger;
  delete cleaned.config;
  return {
    enabled: meta.enabled !== false,
    method,
    trigger: meta.trigger === 'push' ? 'push' : 'manual',
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
  if (settings.dockerImageName) out.DOCKER_IMAGE_NAME = String(settings.dockerImageName);
  if (settings.dockerRegistryUrl) out.DOCKER_REGISTRY_URL = String(settings.dockerRegistryUrl);
  if (settings.dockerHost) out.DOCKER_HOST = String(settings.dockerHost);
  if (settings.kubeNamespace) out.KUBE_NAMESPACE = String(settings.kubeNamespace);
  if (settings.kubeconfig) out.KUBECONFIG = String(settings.kubeconfig);
  if (settings.kubeContext) out.KUBE_CONTEXT = String(settings.kubeContext);
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
  resolveDefaultEnvironmentName,
  getEnabledEnvironmentNames,
  buildEnvironmentEntry,
  resolveEnvTargets,
  mergeMethodSettingsIntoEnv,
};
