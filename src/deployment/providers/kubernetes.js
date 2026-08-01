import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createLogger } from '../../logger/index.js';
import { sanitizeK8sName } from '../../utils/kubernetes-manifests.js';
import { createDockerImageDeployContext } from '../../utils/docker-image-deploy.js';
import { resolveDockerImageRefForTag } from '../../utils/docker-image.js';
import { ensureKubernetesNamespace } from '../../utils/kubernetes-namespace.js';
import { syncKubernetesDeploymentImage } from '../../utils/kubernetes-deploy-image.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createKubernetesProvider(config, envName, env = process.env) {
  const log = createLogger('kubernetes');
  const imageOps = createDockerImageDeployContext(config, env, log);

  const kubeconfig = env.KUBECONFIG || path.join(os.homedir(), '.kube', 'config');
  const context = env.KUBE_CONTEXT || '';
  const namespace = env.KUBE_NAMESPACE || config.project || 'default';
  const deploymentName = sanitizeK8sName(config.project || 'app');

  function getKubectlEnv() {
    const expanded = kubeconfig.replace(/^~/, os.homedir());
    return { ...process.env, KUBECONFIG: path.resolve(expanded) };
  }

  /**
   * Cluster-scoped kubectl args (context only). Used for Namespace get/create.
   * @param {string[]} baseArgs
   */
  function kubectlClusterArgs(baseArgs) {
    /** @type {string[]} */
    const args = [...baseArgs];
    if (context) args.push('--context', context);
    return args;
  }

  /**
   * @param {string[]} baseArgs
   */
  function kubectlArgs(baseArgs) {
    /** @type {string[]} */
    const args = kubectlClusterArgs(baseArgs);
    if (namespace) args.push('--namespace', namespace);
    return args;
  }

  /**
   * @param {string} artifactDir
   * @param {{ fullImage?: string, skipImageReuse?: boolean }} [options]
   */
  async function deploy(artifactDir, options = {}) {
    const imageRef = options.fullImage || imageOps.fullImage;
    const isRollbackRedeploy = Boolean(options.skipImageReuse);

    log.info(`Deploying to Kubernetes (namespace: ${namespace}${context ? `, context: ${context}` : ''})...`);

    // Rollback always rebuilds and must push — without registry creds the cluster
    // cannot pull the new tag and would sit in ImagePullBackOff after a false success.
    if (isRollbackRedeploy && !imageOps.hasRegistryCredentials()) {
      throw new Error(
        'Kubernetes rollback requires DOCKER_REGISTRY_USERNAME and DOCKER_REGISTRY_TOKEN ' +
          `so the rebuilt image (${imageRef}) can be pushed for the cluster to pull. ` +
          'Set those credentials and retry.'
      );
    }

    const manifestDir = artifactDir;
    const hasManifests =
      (await fs.pathExists(path.join(manifestDir, 'k8s'))) ||
      (await fs.readdir(manifestDir)).some((f) => /\.ya?ml$/.test(f));

    if (!hasManifests) {
      throw new Error(
        'No Kubernetes manifests found in artifact. Add .yaml files or a k8s/ directory to your project.'
      );
    }

    log.info(`Ensuring container image ${imageRef} is built and pushed before apply...`);
    const imageResult = await imageOps.ensureImageReadyForDeploy(artifactDir, {
      fullImage: options.fullImage,
      skipImageReuse: options.skipImageReuse,
    });
    if (imageResult.ranCompose) {
      log.warn(
        'docker compose was used — ensure the cluster can pull the resulting image from your registry.'
      );
    }

    await ensureKubernetesNamespace({
      namespace,
      log,
      kubectlArgs: kubectlClusterArgs,
      getKubectlEnv,
    });

    const applyTarget = (await fs.pathExists(path.join(manifestDir, 'k8s')))
      ? path.join(manifestDir, 'k8s')
      : manifestDir;

    await execa('kubectl', kubectlArgs(['apply', '-f', applyTarget]), {
      stdio: 'inherit',
      env: getKubectlEnv(),
    });

    // Always set image to the resolved fullImage (includes registry URL prefix when set).
    // If the live ref already equals fullImage, rollout restart so a new digest is pulled.
    await syncKubernetesDeploymentImage({
      deploymentName,
      fullImage: imageRef,
      kubectlArgs,
      getKubectlEnv,
      log,
    });

    // Rollback-only safety net: wait until pods are actually healthy (catches ImagePullBackOff).
    if (isRollbackRedeploy) {
      const timeout = '120s';
      log.info(
        `Waiting for deployment/${deploymentName} rollout to complete (timeout ${timeout})...`
      );
      try {
        await execa(
          'kubectl',
          kubectlArgs([
            'rollout',
            'status',
            `deployment/${deploymentName}`,
            `--timeout=${timeout}`,
          ]),
          { stdio: 'inherit', env: getKubectlEnv() }
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Kubernetes rollback failed: deployment/${deploymentName} did not become healthy within ${timeout}. ` +
            `The cluster may be unable to pull ${imageRef} (ImagePullBackOff) or pods are failing. ${detail}`
        );
      }
    }

    log.success('Kubernetes deployment complete');
  }

  /**
   * Artifact-based rollback: restore buildId X's code and image (not cluster undo history).
   * @param {string} artifactDir
   * @param {{ buildId?: string, semver?: string, remoteKey?: string }} [meta]
   */
  async function rollback(artifactDir, meta = {}) {
    if (!meta.buildId) {
      throw new Error(
        'Kubernetes rollback requires buildId from the restored artifact history entry'
      );
    }

    const rollbackImage = resolveDockerImageRefForTag(config, env, meta.buildId).fullImage;
    log.info(
      `Rolling back Kubernetes to buildId=${meta.buildId} (image: ${rollbackImage})...`
    );
    await deploy(artifactDir, {
      fullImage: rollbackImage,
      skipImageReuse: true,
    });
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (url) {
      try {
        const { stdout } = await execa('curl', ['-sf', '-o', '/dev/null', '-w', '%{http_code}', url], {
          stdio: 'pipe',
        });
        return stdout.trim().startsWith('2');
      } catch {
        return false;
      }
    }

    try {
      await execa(
        'kubectl',
        kubectlArgs(['rollout', 'status', `deployment/${deploymentName}`, '--timeout=30s']),
        { stdio: 'pipe', env: getKubectlEnv() }
      );
      return true;
    } catch {
      return false;
    }
  }

  async function testConnection() {
    await execa('kubectl', kubectlArgs(['cluster-info']), {
      stdio: 'pipe',
      env: getKubectlEnv(),
    });
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createKubernetesProvider };
