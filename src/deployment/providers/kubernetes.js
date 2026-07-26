import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createLogger } from '../../logger/index.js';
import { sanitizeK8sName } from '../../utils/kubernetes-manifests.js';
import { createDockerImageDeployContext } from '../../utils/docker-image-deploy.js';
import { ensureKubernetesNamespace } from '../../utils/kubernetes-namespace.js';

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
   */
  async function deploy(artifactDir) {
    log.info(`Deploying to Kubernetes (namespace: ${namespace}${context ? `, context: ${context}` : ''})...`);

    const manifestDir = artifactDir;
    const hasManifests =
      (await fs.pathExists(path.join(manifestDir, 'k8s'))) ||
      (await fs.readdir(manifestDir)).some((f) => /\.ya?ml$/.test(f));

    if (!hasManifests) {
      throw new Error(
        'No Kubernetes manifests found in artifact. Add .yaml files or a k8s/ directory to your project.'
      );
    }

    log.info(`Ensuring container image ${imageOps.fullImage} is built and pushed before apply...`);
    const imageResult = await imageOps.ensureImageReadyForDeploy(artifactDir);
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

    const imageName = env.DOCKER_IMAGE_NAME;
    const imageTag = env.DOCKER_IMAGE_TAG || config.version || 'latest';
    if (imageName && config.project) {
      await execa(
        'kubectl',
        kubectlArgs([
          'set',
          'image',
          `deployment/${deploymentName}`,
          `${deploymentName}=${imageName}:${imageTag}`,
        ]),
        { stdio: 'pipe', env: getKubectlEnv() }
      ).catch(() => {
        log.warn('kubectl set image skipped (deployment name may differ from project name)');
      });
    }

    log.success('Kubernetes deployment complete');
  }

  async function rollback(artifactDir) {
    log.info('Rolling back Kubernetes deployment...');
    await execa('kubectl', kubectlArgs(['rollout', 'undo', `deployment/${deploymentName}`]), {
      stdio: 'inherit',
      env: getKubectlEnv(),
    }).catch(async () => {
      log.warn('kubectl rollout undo failed — redeploying previous artifact instead');
      await deploy(artifactDir);
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
