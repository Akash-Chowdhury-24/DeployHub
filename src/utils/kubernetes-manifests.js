import fs from 'fs-extra';
import path from 'path';
import { resolveContainerPort } from './dockerfile-expose.js';

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

  // Service port stays 80 (Ingress-friendly cluster-facing port).
  // containerPort / targetPort must match the container's listening port (EXPOSE).
  const servicePort = 80;
  const targetPort = port;

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
        # Image tag is overwritten at deploy time (kubectl set image uses the resolved build tag)
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
 * Surgically update only containerPort / targetPort in manifest YAML.
 * Does not change Service `port:`, replicas, resources, env, probes, etc.
 *
 * @param {string} yaml
 * @param {number} port
 * @returns {{ content: string, changed: boolean }}
 */
export function patchKubernetesManifestPorts(yaml, port) {
  const next = String(yaml)
    .replace(/^([ \t]*-?[ \t]*containerPort:[ \t]*)\d+[ \t]*$/gm, `$1${port}`)
    .replace(/^([ \t]*targetPort:[ \t]*)\d+[ \t]*$/gm, `$1${port}`);

  return { content: next, changed: next !== yaml };
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, Record<string, unknown>>} [environments]
 * @param {{ port?: number }} [options]
 * @returns {{ appName: string, imageName: string, imageTag: string, port: number, namespace: string, imagePullSecret: string }}
 */
export function resolveKubernetesManifestOptions(config, environments = {}, options = {}) {
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

  /** @type {number} */
  let port;
  if (typeof options.port === 'number' && Number.isFinite(options.port)) {
    port = options.port;
  } else if (config.projectType === 'both' && config.backend?.port) {
    port = Number(config.backend.port);
  } else if (config.port) {
    port = Number(config.port);
  } else if (config.backend?.port) {
    port = Number(config.backend.port);
  } else {
    port = 3000;
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

/**
 * Resolve manifest options with Dockerfile EXPOSE → config → fallback port.
 *
 * @param {string} cwd
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, Record<string, unknown>>} [environments]
 */
export async function resolveKubernetesManifestOptionsFromCwd(
  cwd,
  config,
  environments = {}
) {
  const { port, source } = await resolveContainerPort(cwd, config);
  return {
    ...resolveKubernetesManifestOptions(config, environments, { port }),
    portSource: source,
  };
}

/**
 * Paths DeployHub normally writes for Kubernetes starter manifests.
 * @param {string} cwd
 * @returns {{ deploymentPath: string, servicePath: string }}
 */
export function getDefaultKubernetesManifestPaths(cwd) {
  const k8sDir = path.join(cwd, 'k8s');
  return {
    deploymentPath: path.join(k8sDir, 'deployment.yaml'),
    servicePath: path.join(k8sDir, 'service.yaml'),
  };
}

/**
 * Patch containerPort/targetPort in existing k8s/deployment.yaml + service.yaml only.
 *
 * @param {string} cwd
 * @param {number} port
 * @returns {Promise<{ patched: string[], skipped: string[], port: number }>}
 */
export async function syncKubernetesManifestPorts(cwd, port) {
  const { deploymentPath, servicePath } = getDefaultKubernetesManifestPaths(cwd);
  /** @type {string[]} */
  const patched = [];
  /** @type {string[]} */
  const skipped = [];

  for (const filePath of [deploymentPath, servicePath]) {
    if (!(await fs.pathExists(filePath))) {
      skipped.push(path.relative(cwd, filePath));
      continue;
    }
    const original = await fs.readFile(filePath, 'utf8');
    const { content, changed } = patchKubernetesManifestPorts(original, port);
    if (changed) {
      await fs.writeFile(filePath, content);
      patched.push(path.relative(cwd, filePath));
    } else {
      skipped.push(path.relative(cwd, filePath));
    }
  }

  return { patched, skipped, port };
}

export default {
  sanitizeK8sName,
  hasKubernetesManifests,
  generateKubernetesManifests,
  patchKubernetesManifestPorts,
  resolveKubernetesManifestOptions,
  resolveKubernetesManifestOptionsFromCwd,
  getDefaultKubernetesManifestPaths,
  syncKubernetesManifestPorts,
};
