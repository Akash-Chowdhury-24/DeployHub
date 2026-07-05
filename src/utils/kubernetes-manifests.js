import fs from 'fs-extra';
import path from 'path';

/**
 * @param {string} name
 * @returns {string}
 */
export function sanitizeK8sName(name) {
  const sanitized = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return sanitized || 'app';
}

/**
 * @param {string} cwd
 * @returns {Promise<boolean>}
 */
export async function hasKubernetesManifests(cwd) {
  if (await fs.pathExists(path.join(cwd, 'k8s'))) {
    return true;
  }

  let files = [];
  try {
    files = await fs.readdir(cwd);
  } catch {
    return false;
  }

  for (const file of files) {
    if (!/\.ya?ml$/i.test(file)) continue;
    const content = await fs.readFile(path.join(cwd, file), 'utf-8');
    if (/^\s*apiVersion:/m.test(content) && /^\s*kind:/m.test(content)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {object} options
 * @param {string} options.appName
 * @param {string} options.imageName
 * @param {string} [options.imageTag]
 * @param {number} options.port
 * @param {string} options.namespace
 * @param {string} [options.imagePullSecret]
 * @returns {{ deploymentYaml: string, serviceYaml: string }}
 */
export function generateKubernetesManifests({
  appName,
  imageName,
  imageTag = 'latest',
  port,
  namespace,
  imagePullSecret = '',
}) {
  const name = sanitizeK8sName(appName);
  const image = imageName.includes(':') ? imageName : `${imageName}:${imageTag}`;
  const pullSecretBlock = imagePullSecret
    ? `      imagePullSecrets:\n      - name: ${imagePullSecret}\n`
    : '';

  const deploymentYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  # Adjust replica count as needed
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
${pullSecretBlock}      containers:
      - name: ${name}
        image: ${image}
        ports:
        - containerPort: ${port}
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
`;

  const servicePort = port === 80 ? 80 : 80;
  const targetPort = port;

  const serviceYaml = `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  type: ClusterIP
  selector:
    app: ${name}
  ports:
  - port: ${servicePort}
    targetPort: ${targetPort}
`;

  return { deploymentYaml, serviceYaml };
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, Record<string, unknown>>} [environments]
 * @returns {{ appName: string, imageName: string, imageTag: string, port: number, namespace: string, imagePullSecret: string }}
 */
export function resolveKubernetesManifestOptions(config, environments = {}) {
  const envList = Object.values(environments);
  const k8sEnv = envList.find((env) => env.type === 'kubernetes') || {};

  const appName = config.project || 'app';
  const imageName =
    /** @type {string} */ (k8sEnv.dockerImageName) ||
    process.env.DOCKER_IMAGE_NAME ||
    appName;
  const imageTag =
    process.env.DOCKER_IMAGE_TAG || config.version || 'latest';
  const namespace =
    /** @type {string} */ (k8sEnv.kubeNamespace) ||
    process.env.KUBE_NAMESPACE ||
    appName ||
    'default';
  const imagePullSecret =
    /** @type {string} */ (k8sEnv.kubeImagePullSecret) ||
    process.env.KUBE_IMAGE_PULL_SECRET ||
    '';

  let port = 3000;
  if (config.projectType === 'both' && config.backend?.port) {
    port = config.backend.port;
  } else if (config.port) {
    port = config.port;
  } else if (config.backend?.port) {
    port = config.backend.port;
  }

  return {
    appName,
    imageName,
    imageTag,
    port,
    namespace,
    imagePullSecret,
  };
}

export default {
  sanitizeK8sName,
  hasKubernetesManifests,
  generateKubernetesManifests,
  resolveKubernetesManifestOptions,
};
