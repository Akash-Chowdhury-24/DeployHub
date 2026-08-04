import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import {
  generateDockerfile,
  generateDockerignore,
  getDockerfileFrameworkLabel,
  resolveDockerSettings,
} from './dockerfile.js';
import {
  generateKubernetesManifests,
  hasKubernetesManifests,
  resolveKubernetesManifestOptionsFromCwd,
} from './kubernetes-manifests.js';

/**
 * @param {Record<string, Record<string, unknown>>} environments
 * @returns {Set<string>}
 */
export function getDeployTypes(environments) {
  return new Set(
    Object.values(environments)
      .map((env) => /** @type {string} */ (env.type))
      .filter(Boolean)
  );
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, Record<string, unknown>>} [environments]
 */
export function needsDockerfile(config, environments = config.environments || {}) {
  const deployTypes = getDeployTypes(environments);
  return deployTypes.has('docker') || deployTypes.has('kubernetes');
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, Record<string, unknown>>} [environments]
 */
export function needsKubernetesManifests(
  config,
  environments = config.environments || {}
) {
  return getDeployTypes(environments).has('kubernetes');
}

/**
 * @param {string} cwd
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<{ generated: boolean }>}
 */
export async function ensureDockerignore(cwd, config, options = {}) {
  const dockerignorePath = path.join(cwd, '.dockerignore');
  if (await fs.pathExists(dockerignorePath)) {
    return { generated: false };
  }

  if (!needsDockerfile(config)) {
    return { generated: false };
  }

  await fs.writeFile(dockerignorePath, generateDockerignore(config));

  if (!options.silent) {
    console.log(
      chalk.yellow(
        'No .dockerignore found — generated one at ./.dockerignore to keep node_modules and build caches out of the Docker build context.'
      )
    );
  }

  return { generated: true };
}

/**
 * @param {string} cwd
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<{ generated: boolean, framework?: string, dockerignoreGenerated?: boolean }>}
 */
export async function ensureDockerfile(cwd, config, options = {}) {
  const dockerfilePath = path.join(cwd, 'Dockerfile');
  let generated = false;
  /** @type {string|undefined} */
  let framework;

  if (!(await fs.pathExists(dockerfilePath)) && needsDockerfile(config)) {
    const settings = resolveDockerSettings(config);
    const content = generateDockerfile(config);
    await fs.writeFile(dockerfilePath, content);
    generated = true;
    framework = settings.framework;

    if (!options.silent) {
      const label = getDockerfileFrameworkLabel(settings.framework);
      console.log(
        chalk.yellow(
          `No Dockerfile found — generated a starter Dockerfile at ./Dockerfile based on your detected ${label}. Review it before deploying, especially the exposed port and start command.`
        )
      );
    }
  }

  // Always pair Dockerfile generation path with .dockerignore (never overwrite existing)
  const dockerignoreResult = await ensureDockerignore(cwd, config, options);

  return {
    generated,
    framework,
    dockerignoreGenerated: dockerignoreResult.generated,
  };
}

/**
 * @param {string} cwd
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, Record<string, unknown>>} [environments]
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<{ generated: boolean }>}
 */
export async function ensureKubernetesManifests(
  cwd,
  config,
  environments = config.environments || {},
  options = {}
) {
  if (!needsKubernetesManifests(config, environments)) {
    return { generated: false };
  }

  if (await hasKubernetesManifests(cwd)) {
    return { generated: false };
  }

  const manifestOptions = await resolveKubernetesManifestOptionsFromCwd(
    cwd,
    config,
    environments
  );
  const { deploymentYaml, serviceYaml } = generateKubernetesManifests(manifestOptions);

  const k8sDir = path.join(cwd, 'k8s');
  await fs.ensureDir(k8sDir);
  await fs.writeFile(path.join(k8sDir, 'deployment.yaml'), deploymentYaml);
  await fs.writeFile(path.join(k8sDir, 'service.yaml'), serviceYaml);

  if (!options.silent) {
    console.log(
      chalk.yellow(
        'No Kubernetes manifests found — generated starter manifests at ./k8s/deployment.yaml and ./k8s/service.yaml. Review resource limits, replica count, and any environment-specific settings before deploying.'
      )
    );
  }

  return { generated: true };
}

/**
 * @param {string} cwd
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, Record<string, unknown>>} [environments]
 * @param {{ silent?: boolean }} [options]
 * @returns {Promise<{ dockerfile: boolean, kubernetes: boolean }>}
 */
export async function ensureDeployScaffold(
  cwd,
  config,
  environments = config.environments || {},
  options = {}
) {
  const dockerResult = await ensureDockerfile(cwd, config, options);
  const k8sResult = await ensureKubernetesManifests(cwd, config, environments, options);
  return {
    dockerfile: dockerResult.generated,
    dockerignore: Boolean(dockerResult.dockerignoreGenerated),
    kubernetes: k8sResult.generated,
  };
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 */
export async function copyKubernetesManifestsIfPresent(srcDir, destDir) {
  const k8sSrc = path.join(srcDir, 'k8s');
  if (await fs.pathExists(k8sSrc)) {
    await fs.copy(k8sSrc, path.join(destDir, 'k8s'));
    return;
  }

  let files = [];
  try {
    files = await fs.readdir(srcDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!/\.ya?ml$/i.test(file)) continue;
    const srcFile = path.join(srcDir, file);
    const content = await fs.readFile(srcFile, 'utf-8');
    if (/^\s*apiVersion:/m.test(content) && /^\s*kind:/m.test(content)) {
      await fs.copy(srcFile, path.join(destDir, file));
    }
  }
}

/**
 * Copy deploy-time assets from staging into artifactDir (alongside artifact.zip).
 * @param {string} stagingDir
 * @param {string} artifactDir
 */
export async function copyDeployAssetsToArtifactDir(stagingDir, artifactDir) {
  for (const file of ['Dockerfile', 'docker-compose.yml']) {
    const src = path.join(stagingDir, file);
    if (await fs.pathExists(src)) {
      await fs.copy(src, path.join(artifactDir, file));
    }
  }

  await copyKubernetesManifestsIfPresent(stagingDir, artifactDir);
}

export default {
  ensureDockerfile,
  ensureDockerignore,
  ensureKubernetesManifests,
  ensureDeployScaffold,
  needsDockerfile,
  needsKubernetesManifests,
  copyKubernetesManifestsIfPresent,
  copyDeployAssetsToArtifactDir,
};
