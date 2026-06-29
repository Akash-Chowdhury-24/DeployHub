import fs from 'fs-extra';
import path from 'path';
import { z } from 'zod';
import dotenv from 'dotenv';

const SideConfigSchema = z.object({
  framework: z.string(),
  language: z.string().optional(),
  buildCommand: z.string().nullable().optional(),
  startCommand: z.string().nullable().optional(),
  buildOutput: z.string().optional(),
  port: z.number().optional(),
});

const EnvironmentSchema = z.object({
  type: z.string().optional(),
  deploymentType: z.enum(['platform', 'server']).optional(),
  platform: z.string().optional(),
  projectName: z.string().optional(),
  siteId: z.string().optional(),
  accountId: z.string().optional(),
  appId: z.string().optional(),
  region: z.string().optional(),
  githubConnected: z.boolean().optional(),
  resourceName: z.string().optional(),
  projectId: z.string().optional(),
  backendName: z.string().optional(),
  frontendDeploymentType: z.enum(['platform', 'server']).optional(),
  backendDeploymentType: z.enum(['server']).optional(),
  host: z.string().optional(),
  user: z.string().optional(),
  path: z.string().optional(),
  deployPath: z.string().optional(),
  keyPath: z.string().optional(),
  appName: z.string().optional(),
  framework: z.string().optional(),
  port: z.number().optional(),
  frontendDeployPath: z.string().optional(),
  backendDeployPath: z.string().optional(),
});

const ConfigSchema = z.object({
  project: z.string(),
  version: z.string().optional(),
  projectType: z.enum(['frontend', 'backend', 'both']).default('frontend'),
  framework: z.string().optional(),
  language: z.string().optional(),
  buildCommand: z.string().nullable().optional(),
  startCommand: z.string().nullable().optional(),
  buildOutput: z.string().optional(),
  port: z.number().optional(),
  frontend: SideConfigSchema.optional(),
  backend: SideConfigSchema.optional(),
  docker: z.boolean().default(false),
  artifact: z.boolean().default(true),
  storage: z.array(z.string()).default(['local']),
  deploy: z.array(z.string()).default([]),
  environments: z.record(EnvironmentSchema).default({}),
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

const CONFIG_FILENAME = 'deployhub.config.json';

/**
 * @param {string} [cwd]
 * @returns {string}
 */
export function getConfigPath(cwd = process.cwd()) {
  return path.join(cwd, CONFIG_FILENAME);
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
  const parsed = ConfigSchema.parse(raw);

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

  return parsed;
}

/**
 * @param {DeployHubConfig} config
 * @param {string} [cwd]
 */
export async function saveConfig(config, cwd = process.cwd()) {
  const configPath = getConfigPath(cwd);
  await fs.writeJson(configPath, config, { spaces: 2 });
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

export { ConfigSchema };
