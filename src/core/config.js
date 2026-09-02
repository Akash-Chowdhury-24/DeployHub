import fs from 'fs-extra';
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';
import { createLogger } from '../logger/index.js';
import { ensureLegacyHistoryCopiedToDefaultEnv } from '../storage/index.js';
import {
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
  normalizeGitBranchName,
} from './environments.js';

const SideConfigSchema = z.object({
  framework: z.string(),
  language: z.string().optional(),
  /** PHP runtime for CI (`shivammathur/setup-php`); e.g. `"8.4"`. */
  phpVersion: z.string().optional(),
  buildCommand: z.string().nullable().optional(),
  startCommand: z.string().nullable().optional(),
  buildOutput: z.string().optional(),
  port: z.number().optional(),
});

const HookCommandSchema = z.object({
  command: z.string().min(1),
  continueOnError: z.boolean().optional(),
  timeoutMs: z.number().positive().optional(),
});

/** Method-specific non-secret settings (host, paths, namespace, image name, etc.). */
const MethodConfigSchema = z
  .object({
    deploymentType: z.enum(['server']).optional(),
    frontendDeploymentType: z.enum(['server']).optional(),
    backendDeploymentType: z.enum(['server']).optional(),
    host: z.string().optional(),
    user: z.string().optional(),
    path: z.string().optional(),
    deployPath: z.string().optional(),
    keyPath: z.string().optional(),
    sshPort: z.number().optional(),
    ec2InstanceId: z.string().optional(),
    awsRegion: z.string().optional(),
    azureSubscriptionId: z.string().optional(),
    azureResourceGroup: z.string().optional(),
    azureVmName: z.string().optional(),
    gcpProjectId: z.string().optional(),
    gcpZone: z.string().optional(),
    gcpInstanceName: z.string().optional(),
    kubeconfig: z.string().optional(),
    kubeContext: z.string().optional(),
    kubeNamespace: z.string().optional(),
    dockerImageName: z.string().optional(),
    dockerRegistryUrl: z.string().optional(),
    dockerHost: z.string().optional(),
    /**
     * Docker-method only. Kubernetes must ignore this — it deploys via kubectl,
     * never a remote Docker daemon. `ssh` = node-ssh + remote docker CLI;
     * `local` = this machine; `raw` = unmanaged DOCKER_HOST (ssh:// or tcp://).
     */
    remote: z
      .object({
        mode: z.enum(['ssh', 'local', 'raw']),
      })
      .optional(),
    healthCheckUrl: z.string().optional(),
    /**
     * Remote shell hooks for SSH-based methods (ssh / ec2 / azure-vm / gcp-vm /
     * docker remote.mode ssh). Rejected on kubernetes and docker local/raw.
     */
    hooks: z
      .object({
        preDeploy: z.array(HookCommandSchema).optional(),
        postDeploy: z.array(HookCommandSchema).optional(),
        rollback: z.array(HookCommandSchema).optional(),
      })
      .optional(),
    appName: z.string().optional(),
    framework: z.string().optional(),
    port: z.number().optional(),
    frontendDeployPath: z.string().optional(),
    backendDeployPath: z.string().optional(),
  })
  .passthrough();

const DEPLOY_METHODS = ['ssh', 'docker', 'ec2', 'azure-vm', 'gcp-vm', 'kubernetes'];

/**
 * Per-environment entry. Storage (providers list / credentials) stays project-wide
 * in this pass — per-env storage overrides are a future extension.
 */
const EnvironmentSchema = z.object({
  enabled: z.boolean().default(true),
  method: z.string(),
  trigger: z.enum(['push', 'manual']).default('manual'),
  /** Git branch that auto-deploys this environment on push. Omitted = grandfathered main-only. */
  branch: z.string().min(1).optional(),
  config: MethodConfigSchema.default({}),
});

const ConfigSchema = z.object({
  project: z.string(),
  version: z.string().optional(),
  buildId: z.string().optional(),
  projectType: z.enum(['frontend', 'backend', 'both']).default('frontend'),
  framework: z.string().optional(),
  language: z.string().optional(),
  /**
   * PHP runtime for generated GitHub Actions (`shivammathur/setup-php`).
   * Prefer `backend.phpVersion` for backend/both projects. Default when unset: `8.4`.
   */
  phpVersion: z.string().optional(),
  buildCommand: z.string().nullable().optional(),
  startCommand: z.string().nullable().optional(),
  buildOutput: z.string().optional(),
  port: z.number().optional(),
  frontend: SideConfigSchema.optional(),
  backend: SideConfigSchema.optional(),
  docker: z.boolean().default(false),
  artifact: z.boolean().default(true),
  storage: z.array(z.string()).default(['local']),
  /** @deprecated Prefer environments.*.enabled + defaultEnvironment; kept optional for in-memory BC. */
  deploy: z.array(z.string()).optional().default([]),
  environments: z.record(EnvironmentSchema).default({}),
  defaultEnvironment: z.string().optional(),
  /**
   * Environment that keeps unprefixed CI secrets (SSH_HOST, not DEVELOPMENT_SSH_HOST).
   * Set when the first environment is created; never silently changed when more envs are added.
   */
  unprefixedSecretEnvironment: z.string().optional(),
  /**
   * Set when a project is created via init or when a legacy flat config is silently
   * migrated. Tells ensureLegacyHistoryCopiedToDefaultEnv not to copy the build catalog
   * into the default env (multi-env-native projects never had pre-multi-env deploy history).
   */
  legacyHistoryMigrated: z.boolean().optional(),
  healthCheck: z
    .object({
      url: z.string().default(''),
      timeout: z.number().default(30),
    })
    .default({}),
  notifications: z
    .object({
      slack: z.boolean().default(false),
      email: z.boolean().default(false),
      webhook: z.boolean().default(false),
    })
    .default({}),
  pipeline: z
    .object({
      test: z.boolean().default(true),
      docker: z.boolean().default(false),
      deploy: z.boolean().default(false),
      verify: z.boolean().default(true),
      notify: z.boolean().default(false),
    })
    .default({}),
  artifactRetention: z.number().default(10),
  cli: z
    .object({
      source: z.string().default('npm:@akash-chowdhury-24/deployhub'),
    })
    .default({}),
});

/** @typedef {z.infer<typeof ConfigSchema>} DeployHubConfig */
/** @typedef {z.infer<typeof EnvironmentSchema>} EnvironmentEntry */
/** @typedef {z.infer<typeof MethodConfigSchema>} MethodConfig */

const CONFIG_FILENAME = 'deployhub.config.json';

/** Top-level keys that indicated a pre-environments flat deploy config. */
const FLAT_DEPLOY_KEYS = [
  'type',
  'method',
  'host',
  'user',
  'path',
  'deployPath',
  'keyPath',
  'sshPort',
  'ec2InstanceId',
  'awsRegion',
  'azureSubscriptionId',
  'azureResourceGroup',
  'azureVmName',
  'gcpProjectId',
  'gcpZone',
  'gcpInstanceName',
  'kubeconfig',
  'kubeContext',
  'kubeNamespace',
  'dockerImageName',
  'dockerRegistryUrl',
  'dockerHost',
  'appName',
  'frontendDeployPath',
  'backendDeployPath',
  'deploymentType',
];

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
// isNewEnvironmentShape imported from ./environments.js

/**
 * @param {Record<string, unknown>} entry
 * @returns {Record<string, unknown>}
 */
function extractMethodConfig(entry) {
  /** @type {Record<string, unknown>} */
  const config = { ...(entry.config && typeof entry.config === 'object' ? entry.config : {}) };
  for (const [key, value] of Object.entries(entry)) {
    if (
      key === 'enabled' ||
      key === 'method' ||
      key === 'trigger' ||
      key === 'branch' ||
      key === 'config' ||
      key === 'type'
    ) {
      continue;
    }
    if (value !== undefined) {
      config[key] = value;
    }
  }
  return config;
}

/**
 * Preserve `environments.<env>.branch` across migration without inventing one.
 * @param {Record<string, unknown>} entry
 * @returns {{ branch?: string }}
 */
function copyEnvBranch(entry) {
  const parsed = normalizeGitBranchName(entry.branch);
  return parsed.ok ? { branch: parsed.name } : {};
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {boolean}
 */
export function needsConfigMigration(raw) {
  if (!raw || typeof raw !== 'object') return false;

  const envs = raw.environments;
  if (!envs || typeof envs !== 'object' || Array.isArray(envs)) {
    return FLAT_DEPLOY_KEYS.some((k) => raw[k] !== undefined);
  }

  const entries = Object.values(envs);
  if (entries.some((e) => e && typeof e === 'object' && !isNewEnvironmentShape(e))) {
    return true;
  }

  // Legacy deploy[] without defaultEnvironment (even when env shapes are already new)
  if (Array.isArray(raw.deploy) && raw.deploy.length > 0 && !raw.defaultEnvironment) {
    return true;
  }

  if (entries.length > 0 && !raw.defaultEnvironment) {
    return true;
  }

  return false;
}

/**
 * Migrate legacy flat / type-at-top-level environment configs to
 * `{ enabled, method, trigger, config }` + `defaultEnvironment`.
 * Idempotent: already-migrated configs are returned unchanged.
 *
 * @param {Record<string, unknown>} raw
 * @returns {{ config: Record<string, unknown>, migrated: boolean, reason: string|null }}
 */
export function migrateConfigToEnvironments(raw) {
  if (!needsConfigMigration(raw)) {
    return { config: raw, migrated: false, reason: null };
  }

  /** @type {Record<string, unknown>} */
  const next = { ...raw };
  const legacyDeploy = Array.isArray(raw.deploy) ? raw.deploy.map(String) : [];

  /** @type {Record<string, Record<string, unknown>>} */
  const newEnvironments = {};

  const rawEnvs =
    raw.environments && typeof raw.environments === 'object' && !Array.isArray(raw.environments)
      ? /** @type {Record<string, Record<string, unknown>>} */ (raw.environments)
      : null;

  if (rawEnvs && Object.keys(rawEnvs).length > 0) {
    for (const [name, entry] of Object.entries(rawEnvs)) {
      if (!entry || typeof entry !== 'object') continue;
      if (isNewEnvironmentShape(entry)) {
        newEnvironments[name] = {
          enabled: entry.enabled !== false,
          method: String(entry.method),
          trigger: entry.trigger === 'push' ? 'push' : 'manual',
          ...copyEnvBranch(entry),
          config: extractMethodConfig(entry),
        };
        continue;
      }

      const method = String(entry.method || entry.type || 'ssh');
      const enabled =
        legacyDeploy.length === 0 ? true : legacyDeploy.includes(name);
      newEnvironments[name] = {
        enabled,
        method,
        trigger: entry.trigger === 'push' ? 'push' : 'manual',
        ...copyEnvBranch(entry),
        config: extractMethodConfig(entry),
      };
    }
  } else {
    // Truly flat single-environment config (method/type + settings at top level).
    const method = String(raw.method || raw.type || 'ssh');
    /** @type {Record<string, unknown>} */
    const flatConfig = {};
    for (const key of FLAT_DEPLOY_KEYS) {
      if (key === 'type' || key === 'method') continue;
      if (raw[key] !== undefined) flatConfig[key] = raw[key];
    }
    newEnvironments.default = {
      enabled: true,
      method,
      trigger: 'push',
      config: flatConfig,
    };
    for (const key of FLAT_DEPLOY_KEYS) {
      delete next[key];
    }
  }

  let defaultEnvironment =
    typeof raw.defaultEnvironment === 'string' && raw.defaultEnvironment
      ? raw.defaultEnvironment
      : null;

  if (!defaultEnvironment || !newEnvironments[defaultEnvironment]) {
    if (legacyDeploy[0] && newEnvironments[legacyDeploy[0]]) {
      defaultEnvironment = legacyDeploy[0];
    } else if (newEnvironments.default) {
      defaultEnvironment = 'default';
    } else if (newEnvironments.production) {
      defaultEnvironment = 'production';
    } else {
      const enabledNames = Object.entries(newEnvironments)
        .filter(([, e]) => e.enabled !== false)
        .map(([n]) => n);
      defaultEnvironment =
        enabledNames[0] || Object.keys(newEnvironments)[0] || 'default';
    }
  }

  if (!newEnvironments[defaultEnvironment] && Object.keys(newEnvironments).length === 0) {
    newEnvironments[defaultEnvironment] = {
      enabled: true,
      method: 'ssh',
      trigger: 'push',
      config: {},
    };
  }

  next.environments = newEnvironments;
  next.defaultEnvironment = defaultEnvironment;
  if (!next.unprefixedSecretEnvironment) {
    next.unprefixedSecretEnvironment = defaultEnvironment;
  }
  // deploy[] is superseded by enabled + defaultEnvironment
  delete next.deploy;

  const reason =
    !rawEnvs || Object.keys(rawEnvs).length === 0
      ? 'flat'
      : 'legacy-environments';

  return { config: next, migrated: true, reason };
}

/**
 * @param {string} [cwd]
 * @returns {string}
 */
export function getConfigPath(cwd = process.cwd()) {
  return path.join(cwd, CONFIG_FILENAME);
}

/**
 * @param {DeployHubConfig} config
 */
export function validateConfigConsistency(config) {
  const envs = config.environments || {};
  const def = config.defaultEnvironment;
  if (typeof def === 'string' && def && !envs[def]) {
    throw new Error(
      `defaultEnvironment "${def}" is not defined in environments. ` +
        'Fix deployhub.config.json (typo?) or run deployhub env list.'
    );
  }
}

/**
 * @param {string} [cwd]
 * @returns {Promise<DeployHubConfig>}
 */
export async function loadConfig(cwd = process.cwd()) {
  const configPath = getConfigPath(cwd);
  if (!(await fs.pathExists(configPath))) {
    throw new Error(
      `Config not found at ${configPath}. Run "deployhub init" first.`
    );
  }
  const raw = await fs.readJson(configPath);
  const { config: migratedRaw, migrated, reason } = migrateConfigToEnvironments(raw);

  if (migrated) {
    const log = createLogger('config');
    if (reason === 'flat') {
      log.warn('Old single-environment config detected.');
      log.warn('  Migrating to environments.default using your existing settings.');
      log.warn(
        '  Nothing changes in behavior — this just adds room for more environments later.'
      );
    } else {
      log.warn('Legacy environment config format detected.');
      log.warn(
        '  Migrating to enabled/method/trigger/config shape (defaultEnvironment set).'
      );
      log.warn(
        '  Nothing changes in behavior — this just adds room for more environments later.'
      );
    }
    await fs.writeJson(configPath, migratedRaw, { spaces: 2 });

    const storage = /** @type {string[]|undefined} */ (migratedRaw.storage);
    if (
      Array.isArray(storage) &&
      storage.length > 0 &&
      migratedRaw.project &&
      migratedRaw.defaultEnvironment
    ) {
      await ensureLegacyHistoryCopiedToDefaultEnv(
        storage,
        String(migratedRaw.project),
        String(migratedRaw.defaultEnvironment)
      );
    }
  }

  const parsed = ConfigSchema.parse(migratedRaw);

  if (!parsed.framework && parsed.projectType === 'frontend') {
    parsed.framework = 'node';
  }
  if (parsed.buildCommand === undefined && parsed.projectType !== 'backend') {
    parsed.buildCommand = 'npm run build';
  }
  if (!parsed.buildOutput) {
    parsed.buildOutput = parsed.projectType === 'backend' ? '.' : 'dist';
  }
  if (!parsed.version) {
    parsed.version = '0.0.0';
  }

  if (!parsed.defaultEnvironment) {
    parsed.defaultEnvironment = resolveDefaultEnvironmentName(parsed) || undefined;
  }

  // Grandfather unprefixed CI secrets for the original environment (in-memory;
  // persisted on next saveConfig / env add / migration rewrite).
  if (!parsed.unprefixedSecretEnvironment) {
    const envNames = Object.keys(parsed.environments || {});
    if (envNames.length >= 1) {
      parsed.unprefixedSecretEnvironment =
        parsed.defaultEnvironment && parsed.environments[parsed.defaultEnvironment]
          ? parsed.defaultEnvironment
          : envNames[0];
    }
  }

  // Keep deploy[] in sync for code paths that still read it (pipeline, doctor, workflows).
  parsed.deploy = getEnabledEnvironmentNames(parsed);

  validateConfigConsistency(parsed);

  return parsed;
}

/**
 * @param {DeployHubConfig} config
 * @param {string} [cwd]
 */
export async function saveConfig(config, cwd = process.cwd()) {
  const configPath = getConfigPath(cwd);
  /** @type {Record<string, unknown>} */
  const toWrite = { ...config };
  // Persist new shape only — deploy[] is derived at load time.
  delete toWrite.deploy;
  await fs.writeJson(configPath, toWrite, { spaces: 2 });
}

/**
 * @param {string} [cwd]
 */
export function loadEnv(cwd = process.cwd()) {
  dotenv.config({ path: path.join(cwd, '.env') });
}

/**
 * @param {Record<string, string>} vars
 * @param {string} [cwd]
 */
export async function appendEnv(vars, cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env');
  const lines = [];
  for (const [key, value] of Object.entries(vars)) {
    if (value) {
      lines.push(`${key}=${value}`);
    }
  }
  if (lines.length === 0) return;

  const existing = (await fs.pathExists(envPath))
    ? await fs.readFile(envPath, 'utf-8')
    : '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(envPath, `${separator}${lines.join('\n')}\n`);
}

export {
  ConfigSchema,
  EnvironmentSchema,
  MethodConfigSchema,
  DEPLOY_METHODS,
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
