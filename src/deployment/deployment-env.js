/**
 * Central source of truth for deployment method env vars, documentation,
 * and post-init next steps.
 */

import { getEnvSettings } from '../core/environments.js';
import { resolveDockerRemoteMode } from '../utils/docker-remote-mode.js';

/** @typedef {{ key: string, comment: string[], example?: string, default?: string, optionalReason?: string, when?: 'backend'|'optional'|'ci' }} EnvVarDef */

/** @type {Record<string, EnvVarDef[]>} */
export const SSH_BASE_ENV_VARS = [
  {
    key: 'SSH_HOST',
    comment: [
      'Public IP address or domain name of the server you are deploying to.',
    ],
    example: '203.0.113.10',
  },
  {
    key: 'SSH_USER',
    comment: [
      'OS username for SSH login. Depends on the image you used:',
      '  Ubuntu → ubuntu | Amazon Linux → ec2-user | Debian → admin',
      'Check your provider instance details if unsure.',
    ],
    example: 'ubuntu',
  },
  {
    key: 'SSH_KEY_PATH',
    comment: [
      'Path to your PRIVATE SSH key file (the .pem/.key you downloaded).',
      'Must be a file PATH — do not paste key contents here.',
    ],
    example: '~/.ssh/my-server-key.pem',
  },
  {
    key: 'SSH_SSH_PORT',
    optionalReason: 'only change from default 22 if your server uses a non-standard SSH port',
    comment: ['SSH connection port on the server (not your app port).'],
    default: '22',
    when: 'optional',
  },
  {
    key: 'SSH_DEPLOY_PATH',
    optionalReason: 'only needed if the deploy path differs from deployhub.config.json',
    comment: [
      'Remote directory where DeployHub extracts your artifact.',
      'The SSH user must have write permission here.',
    ],
    example: '/var/www/my-app',
    when: 'optional',
  },
];

/** @type {EnvVarDef[]} */
export const SSH_BACKEND_ENV_VARS = [
  {
    key: 'SSH_APP_NAME',
    comment: [
      'Env-scoped process identity: PM2 app name (Node), DEPLOYHUB_APP / PID markers (Python, Java, Go, .NET, Rails), and related resource names. Not the php-fpm systemd unit.',
    ],
    example: 'my-api',
    when: 'backend',
  },
  {
    key: 'SSH_PORT',
    comment: [
      'TCP port your backend app listens on (used for health checks and start commands).',
    ],
    example: '3000',
    when: 'backend',
  },
];

/** @type {EnvVarDef[]} */
export const SSH_CI_ENV_VARS = [
  {
    key: 'SSH_KEY',
    optionalReason:
      'only required for GitHub Actions / CI — paste private key contents here; use SSH_KEY_PATH for local development',
    comment: [
      'PRIVATE SSH key contents (full PEM block including BEGIN/END lines).',
    ],
    when: 'ci',
  },
];

/** @type {Record<string, EnvVarDef[]>} */
export const DEPLOYMENT_ENV_DEFS = {
  ssh: [...SSH_BASE_ENV_VARS, ...SSH_BACKEND_ENV_VARS, ...SSH_CI_ENV_VARS],
  docker: [
    {
      key: 'DOCKER_IMAGE_NAME',
      comment: [
        'Docker image name (repository path without tag).',
      ],
      example: 'myorg/myapp',
    },
    {
      key: 'DOCKER_IMAGE_TAG',
      optionalReason:
        'leave unset for a unique tag per build (git SHA → CI run id → timestamp); explicit tags are reused as-is',
      comment: [
        'Optional. Leave unset for a unique tag per build (git SHA, CI run id, or timestamp).',
        'If set explicitly, the same tag is reused — Kubernetes may keep stale pods unless imagePullPolicy is Always or a rollout restart runs.',
      ],
      example: 'latest',
      when: 'optional',
    },
    {
      key: 'DOCKER_REGISTRY_URL',
      optionalReason: 'only required for private or non-Docker-Hub registries',
      comment: [
        'Container registry URL. Leave empty for Docker Hub.',
        'Examples: https://index.docker.io/v1/ | https://ghcr.io',
      ],
      when: 'optional',
    },
    {
      key: 'DOCKER_REGISTRY_USERNAME',
      optionalReason: 'only required when pushing to a private registry',
      comment: ['Registry username for pushing private images.'],
      when: 'optional',
    },
    {
      key: 'DOCKER_REGISTRY_TOKEN',
      optionalReason: 'only required when pushing to a private registry',
      comment: [
        'Registry password or personal access token.',
        'Docker Hub: access token. GHCR: GitHub PAT with write:packages.',
      ],
      when: 'optional',
    },
    {
      key: 'DOCKER_HOST',
      optionalReason:
        'only for advanced raw Docker CLI transport (tcp:// or custom ssh://). Prefer remote.mode "ssh" (SSH_HOST / SSH_USER / SSH_KEY_PATH) for a remote Linux box',
      comment: [
        'Advanced/escape-hatch: raw Docker daemon URI. DeployHub cannot validate ssh:// via doctor.',
        'Prefer "Remote Linux server via SSH" at init (remote.mode: ssh) unless you manage TLS/ssh:// yourself.',
        'Examples: tcp://203.0.113.10:2376 | ssh://ubuntu@203.0.113.10',
      ],
      when: 'optional',
    },
    {
      key: 'DOCKER_TLS_VERIFY',
      optionalReason: 'only required when DOCKER_HOST uses tcp:// with TLS',
      comment: ['Set to 1 when connecting to a remote Docker daemon over TLS.'],
      when: 'optional',
    },
    {
      key: 'DOCKER_CERT_PATH',
      optionalReason: 'only required when DOCKER_HOST uses tcp:// with TLS',
      comment: [
        'Directory containing ca.pem, cert.pem, and key.pem for Docker TLS.',
      ],
      when: 'optional',
    },
  ],
  ec2: [
    ...SSH_BASE_ENV_VARS,
    ...SSH_BACKEND_ENV_VARS,
    ...SSH_CI_ENV_VARS,
    {
      key: 'EC2_INSTANCE_ID',
      optionalReason:
        'only required for dynamic public IP lookup via AWS API; otherwise set SSH_HOST directly',
      comment: [
        'AWS EC2 instance ID. Used to look up the public IP via AWS API.',
        'If unset, SSH_HOST must be set to the instance public IP or DNS.',
      ],
      example: 'i-0abc123def4567890',
      when: 'optional',
    },
    {
      key: 'EC2_LOOKUP_AWS_ACCESS_KEY_ID',
      optionalReason:
        'only required if using EC2_INSTANCE_ID for dynamic IP lookup; otherwise leave blank',
      comment: [
        'EC2 instance-IP lookup credential (NOT the same as AWS S3 storage credentials).',
        'AWS access key with ec2:DescribeInstances permission.',
        'Create in AWS Console → IAM → Users → Security credentials.',
      ],
      when: 'optional',
    },
    {
      key: 'EC2_LOOKUP_AWS_SECRET_ACCESS_KEY',
      optionalReason:
        'only required if using EC2_INSTANCE_ID for dynamic IP lookup; otherwise leave blank',
      comment: [
        'Secret for EC2_LOOKUP_AWS_ACCESS_KEY_ID (distinct from AWS_SECRET_ACCESS_KEY used by S3).',
      ],
      when: 'optional',
    },
    {
      key: 'EC2_LOOKUP_AWS_REGION',
      optionalReason:
        'only required if using EC2_INSTANCE_ID for dynamic IP lookup; otherwise leave blank',
      comment: [
        'AWS region for EC2 DescribeInstances lookup (distinct from AWS_REGION used by S3).',
      ],
      example: 'us-east-1',
      when: 'optional',
    },
  ],
  'azure-vm': [
    ...SSH_BASE_ENV_VARS,
    ...SSH_BACKEND_ENV_VARS,
    ...SSH_CI_ENV_VARS,
    {
      key: 'AZURE_VM_LOOKUP_SUBSCRIPTION_ID',
      optionalReason:
        'only required for dynamic VM IP lookup via Azure API; otherwise set SSH_HOST directly',
      comment: [
        'Azure VM IP-lookup subscription ID (deployment-side; not Azure Blob storage).',
        'Find in Azure Portal → Subscriptions, or run: az account show --query id -o tsv',
      ],
      when: 'optional',
    },
    {
      key: 'AZURE_VM_LOOKUP_RESOURCE_GROUP',
      optionalReason:
        'only required for dynamic VM IP lookup via Azure API; otherwise leave blank',
      comment: [
        'Resource group containing your VM (deployment lookup; not Azure Blob storage).',
      ],
      example: 'my-app-rg',
      when: 'optional',
    },
    {
      key: 'AZURE_VM_LOOKUP_VM_NAME',
      optionalReason:
        'only required for dynamic VM IP lookup via Azure API; otherwise set SSH_HOST directly',
      comment: [
        'Name of the Azure virtual machine for IP lookup.',
        'If unset, SSH_HOST must be set to the VM public IP or DNS.',
      ],
      when: 'optional',
    },
    {
      key: 'AZURE_VM_LOOKUP_TENANT_ID',
      optionalReason:
        'only required for non-interactive CI deploys (GitHub Actions) using a service principal',
      comment: [
        'Azure AD tenant ID for service principal auth in CI (VM deploy lookup).',
      ],
      when: 'optional',
    },
    {
      key: 'AZURE_VM_LOOKUP_CLIENT_ID',
      optionalReason:
        'only required for non-interactive CI deploys (GitHub Actions) using a service principal',
      comment: [
        'Service principal application (client) ID for CI auth (VM deploy lookup).',
      ],
      when: 'optional',
    },
    {
      key: 'AZURE_VM_LOOKUP_CLIENT_SECRET',
      optionalReason:
        'only required for non-interactive CI deploys (GitHub Actions) using a service principal',
      comment: [
        'Service principal client secret for CI auth (VM deploy lookup).',
      ],
      when: 'optional',
    },
  ],
  'gcp-vm': [
    ...SSH_BASE_ENV_VARS,
    ...SSH_BACKEND_ENV_VARS,
    ...SSH_CI_ENV_VARS,
    {
      key: 'GCP_VM_LOOKUP_PROJECT_ID',
      optionalReason:
        'only required for dynamic VM IP lookup via GCP API; otherwise set SSH_HOST directly',
      comment: [
        'GCP project ID for Compute Engine IP lookup (NOT the same as GCP Storage GCP_PROJECT_ID).',
        'Find in GCP Console → Dashboard, or run: gcloud config get-value project',
      ],
      when: 'optional',
    },
    {
      key: 'GCP_ZONE',
      optionalReason:
        'only required for dynamic VM IP lookup via GCP API; otherwise leave blank',
      comment: ['GCP zone where your VM runs.'],
      example: 'us-central1-a',
      when: 'optional',
    },
    {
      key: 'GCP_INSTANCE_NAME',
      optionalReason:
        'only required for dynamic VM IP lookup via GCP API; otherwise set SSH_HOST directly',
      comment: [
        'GCP Compute Engine instance name.',
        'GCP uses project/instance SSH keys in metadata — add your public key in',
        'Console → Compute Engine → Metadata → SSH Keys.',
      ],
      when: 'optional',
    },
    {
      key: 'GCP_VM_LOOKUP_KEY_FILE',
      optionalReason:
        'only required for dynamic VM IP lookup via GCP API or non-interactive CI auth; otherwise leave blank',
      comment: [
        'Path to a GCP service account JSON key for VM IP lookup (distinct from GCP Storage GCP_KEY_FILE).',
        'Create in GCP Console → IAM → Service Accounts → Keys.',
      ],
      when: 'optional',
    },
  ],
  kubernetes: [
    {
      key: 'KUBECONFIG',
      optionalReason: 'defaults to ~/.kube/config if unset',
      comment: ['Path to your kubeconfig file.'],
      example: '~/.kube/config',
      when: 'optional',
    },
    {
      key: 'KUBE_CONTEXT',
      comment: [
        'kubectl context name to deploy into.',
        'List contexts: kubectl config get-contexts',
      ],
      example: 'my-cluster',
    },
    {
      key: 'KUBE_NAMESPACE',
      optionalReason: 'defaults to your project name or "default" if unset',
      comment: [
        'Kubernetes namespace for your deployment.',
        'If missing, deployhub deploy prompts to create it locally (or auto-creates in CI).',
      ],
      example: 'my-app',
      when: 'optional',
    },
    {
      key: 'DOCKER_IMAGE_NAME',
      comment: [
        'Container image to build, push, and deploy.',
        'Kubernetes clusters pull from a registry — local-only Docker images will not work.',
      ],
      example: 'ghcr.io/myorg/myapp',
    },
    {
      key: 'DOCKER_IMAGE_TAG',
      optionalReason:
        'leave unset for a unique tag per build (git SHA → CI run id → timestamp); explicit tags are reused as-is',
      comment: [
        'Optional image tag. Unset → DeployHub auto-generates a unique tag each build.',
        'If set, that exact tag is used — reusing it can leave pods on a stale image (IfNotPresent) unless you rely on deploy-time rollout restart or set imagePullPolicy: Always.',
      ],
      example: 'latest',
      when: 'optional',
    },
    {
      key: 'DOCKER_REGISTRY_URL',
      optionalReason: 'leave empty for Docker Hub',
      comment: [
        'Container registry URL. Leave empty for Docker Hub.',
        'Examples: https://index.docker.io/v1/ | https://ghcr.io',
      ],
      when: 'optional',
    },
    {
      key: 'DOCKER_REGISTRY_USERNAME',
      comment: [
        'Registry username — required to push so the cluster can pull your image.',
        'Even public Docker Hub repos require authentication to push.',
      ],
      example: 'myuser',
    },
    {
      key: 'DOCKER_REGISTRY_TOKEN',
      comment: [
        'Registry password or personal access token — required to push so the cluster can pull.',
        'Docker Hub: access token. GHCR: GitHub PAT with write:packages.',
      ],
    },
    {
      key: 'KUBE_IMAGE_PULL_SECRET',
      optionalReason: 'only required when pulling from a private container registry',
      comment: [
        'Name of a Kubernetes imagePullSecret for private registries.',
        'Create with: kubectl create secret docker-registry ...',
      ],
      when: 'optional',
    },
  ],
};

/** @type {Record<string, string[]>} */
export const DEPLOYMENT_ENV_KEYS = Object.fromEntries(
  Object.entries(DEPLOYMENT_ENV_DEFS).map(([method, defs]) => [
    method,
    defs.map((d) => d.key),
  ])
);

const DOCKER_HOST_KEYS = new Set(['DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']);

/**
 * SSH identity vars used when docker `remote.mode === "ssh"`.
 * Same names as ec2; per-env secret prefixing separates a sibling ssh/ec2 env.
 * Not listed in static DEPLOYMENT_ENV_KEYS.docker (local/raw docker do not read them).
 */
export const DOCKER_SSH_ENV_VARS = [
  ...SSH_BASE_ENV_VARS.filter((d) => d.key !== 'SSH_DEPLOY_PATH'),
  ...SSH_CI_ENV_VARS,
];

/**
 * @param {Record<string, unknown>|null|undefined} settings
 * @returns {boolean}
 */
function dockerHasExplicitRemoteMode(settings) {
  const remote = settings && /** @type {Record<string, unknown>} */ (settings).remote;
  const mode =
    remote && typeof remote === 'object'
      ? /** @type {Record<string, unknown>} */ (remote).mode
      : undefined;
  return mode === 'ssh' || mode === 'local' || mode === 'raw';
}

/**
 * Per-env docker defs: ssh mode adds SSH_* and drops raw DOCKER_HOST;
 * explicit local drops DOCKER_HOST; configs with no remote.mode keep legacy defs.
 *
 * @param {string} deployType
 * @param {Record<string, unknown>|null} [settings]
 * @returns {EnvVarDef[]}
 */
export function getMethodEnvDefs(deployType, settings = null) {
  const defs = DEPLOYMENT_ENV_DEFS[deployType] || [];
  if (deployType !== 'docker') return defs;
  const s = settings || {};
  if (!dockerHasExplicitRemoteMode(s)) {
    return defs;
  }
  const mode = resolveDockerRemoteMode(s, {});
  if (mode === 'ssh') {
    return [...defs.filter((d) => !DOCKER_HOST_KEYS.has(d.key)), ...DOCKER_SSH_ENV_VARS];
  }
  if (mode === 'local') {
    return defs.filter((d) => !DOCKER_HOST_KEYS.has(d.key));
  }
  return defs;
}

/**
 * Deployment-side cloud-API lookup credentials — distinct from storage-provider
 * env vars (storage stays project-wide / unprefixed).
 *
 * Convention: `{METHOD}_LOOKUP_…` — method-scoped, purpose-clear, layers under
 * the existing multi-env prefixing system (e.g. PRODUCTION_EC2_LOOKUP_AWS_ACCESS_KEY_ID).
 */
export const DEPLOYMENT_LOOKUP_ENV_KEYS = new Set([
  'EC2_LOOKUP_AWS_ACCESS_KEY_ID',
  'EC2_LOOKUP_AWS_SECRET_ACCESS_KEY',
  'EC2_LOOKUP_AWS_REGION',
  'AZURE_VM_LOOKUP_SUBSCRIPTION_ID',
  'AZURE_VM_LOOKUP_RESOURCE_GROUP',
  'AZURE_VM_LOOKUP_VM_NAME',
  'AZURE_VM_LOOKUP_TENANT_ID',
  'AZURE_VM_LOOKUP_CLIENT_ID',
  'AZURE_VM_LOOKUP_CLIENT_SECRET',
  'GCP_VM_LOOKUP_PROJECT_ID',
  'GCP_VM_LOOKUP_KEY_FILE',
]);

/**
 * Locally required env keys for doctor method-specific checks.
 * Excludes optional and CI-only vars.
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string[]}
 */
export function getDeploymentEnvKeys(deployType, config = null, settings = null) {
  const defs = getMethodEnvDefs(deployType, settings);
  const projectType = config?.projectType || 'frontend';
  const isBackend = projectType === 'backend' || projectType === 'both';

  return defs
    .filter((d) => {
      if (d.when === 'backend' && !isBackend) return false;
      if (d.when === 'ci') return false;
      if (d.when === 'optional') return false;
      return true;
    })
    .map((d) => d.key);
}

/**
 * Map a def key to the GitHub Actions secret name (SSH_KEY_PATH → SSH_KEY).
 * @param {string} key
 */
function toGithubSecretKey(key) {
  return key === 'SSH_KEY_PATH' ? 'SSH_KEY' : key;
}

/**
 * Genuinely required secrets for doctor "Secrets" check and required checklist items.
 * Includes CI-only vars (e.g. SSH_KEY) but NOT optional vars.
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string[]}
 */
export function getDeploymentSecretKeys(deployType, config = null, settings = null) {
  const defs = getMethodEnvDefs(deployType, settings);
  const projectType = config?.projectType || 'frontend';
  const isBackend = projectType === 'backend' || projectType === 'both';

  /** @type {string[]} */
  const keys = [];

  for (const d of defs) {
    if (d.when === 'backend' && !isBackend) continue;
    if (d.when === 'optional') continue;
    keys.push(toGithubSecretKey(d.key));
  }

  return [...new Set(keys)];
}

/**
 * Broad CI-wiring list for the GitHub Actions workflow generator.
 * Includes required, CI-only, and optional keys so `${{ secrets.X }}` is
 * available when the user sets optional secrets — empty secrets are fine.
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string[]}
 */
export function getDeploymentWorkflowSecretKeys(deployType, config = null, settings = null) {
  const defs = getMethodEnvDefs(deployType, settings);
  const projectType = config?.projectType || 'frontend';
  const isBackend = projectType === 'backend' || projectType === 'both';

  /** @type {string[]} */
  const keys = [];

  for (const d of defs) {
    if (d.when === 'backend' && !isBackend) continue;
    keys.push(toGithubSecretKey(d.key));
  }

  return [...new Set(keys)];
}

/**
 * @typedef {{ key: string, required: boolean, note?: string }} SecretChecklistItem
 */

/**
 * Labeled GitHub Secrets checklist entries for a single deploy method.
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {SecretChecklistItem[]}
 */
export function getDeploymentSecretChecklistItems(deployType, config = null, settings = null) {
  const defs = getMethodEnvDefs(deployType, settings);
  const projectType = config?.projectType || 'frontend';
  const isBackend = projectType === 'backend' || projectType === 'both';

  /** @type {Map<string, SecretChecklistItem>} */
  const byKey = new Map();

  for (const d of defs) {
    if (d.when === 'backend' && !isBackend) continue;

    const key = toGithubSecretKey(d.key);
    const required = d.when !== 'optional';
    let note =
      d.when === 'optional'
        ? d.optionalReason
        : d.when === 'ci'
          ? d.optionalReason || 'required for GitHub Actions CI (paste private key contents)'
          : undefined;

    if (DEPLOYMENT_LOOKUP_ENV_KEYS.has(d.key)) {
      const purpose =
        deployType === 'ec2'
          ? 'EC2 instance-IP lookup credential (distinct from AWS S3 storage)'
          : deployType === 'gcp-vm'
            ? 'GCP VM instance-IP lookup credential (distinct from GCP Storage)'
            : deployType === 'azure-vm'
              ? 'Azure VM IP-lookup credential (distinct from Azure Blob storage)'
              : 'deployment cloud-API lookup credential';
      note = note ? `${purpose}; ${note}` : purpose;
    }

    const existing = byKey.get(key);
    if (existing) {
      // Prefer required if any def for this key is required
      if (required && !existing.required) {
        byKey.set(key, { key, required: true, note });
      }
      continue;
    }

    byKey.set(key, { key, required, note });
  }

  return Array.from(byKey.values());
}

/**
 * Uppercase env name for secret prefixes (e.g. production → PRODUCTION).
 * @param {string} envName
 * @returns {string}
 */
export function envSecretPrefix(envName) {
  return (
    String(envName || 'default')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'DEFAULT'
  );
}

/**
 * Trade-off (superseded for per-env grandfathering): true when 2+ environments exist.
 * Prefer envUsesPrefixedSecrets(envName, config) so the original env stays unprefixed.
 *
 * @param {Record<string, unknown>} [environments]
 * @returns {boolean}
 */
export function shouldPrefixEnvSecrets(environments) {
  return Object.keys(environments || {}).length > 1;
}

/**
 * Which environment keeps reading unprefixed secrets (SSH_HOST, not ENV_SSH_HOST).
 * Once established, this must not silently change when more environments are added.
 *
 * @param {Record<string, unknown>} config
 * @returns {string|null}
 */
export function resolveUnprefixedSecretEnvironment(config) {
  const envs = /** @type {Record<string, unknown>} */ (config.environments || {});
  const named = config.unprefixedSecretEnvironment;
  if (typeof named === 'string' && envs[named]) return named;

  const names = Object.keys(envs);
  if (names.length === 1) return names[0];
  if (typeof config.defaultEnvironment === 'string' && envs[config.defaultEnvironment]) {
    return config.defaultEnvironment;
  }
  return names[0] || null;
}

/**
 * Whether this environment's CI secrets use ENVNAME_KEY prefixes.
 * - 0–1 environments: never prefixed (BC).
 * - 2+ environments: every env EXCEPT the grandfathered unprefixedSecretEnvironment is prefixed.
 *
 * @param {string} envName
 * @param {Record<string, unknown>} config
 * @returns {boolean}
 */
export function envUsesPrefixedSecrets(envName, config) {
  const envs = config.environments || {};
  if (Object.keys(envs).length <= 1) return false;
  const unprefixed = resolveUnprefixedSecretEnvironment(config);
  return envName !== unprefixed;
}

/**
 * @param {string} envName
 * @param {string} key
 * @returns {string}
 */
export function prefixSecretKey(envName, key) {
  return `${envSecretPrefix(envName)}_${key}`;
}

/**
 * Overlay prefixed CI secrets (e.g. STAGING_SSH_HOST) onto the unprefixed names
 * providers already read (SSH_HOST). Used when a workflow job carries secrets for
 * multiple environments — static YAML can only map one value per unprefixed key.
 *
 * For prefixed environments, ambient unprefixed leftovers (e.g. a developer's
 * shell SSH_HOST from another project) are cleared unless a matching prefixed
 * secret is present — config settings (host, dockerImageName, …) still win via
 * provider resolution / mergeMethodSettingsIntoEnv.
 *
 * @param {string} envName
 * @param {Record<string, unknown>} config
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string|undefined>}
 */
export function applyEnvSecretOverlay(envName, config, env = process.env) {
  /** @type {Record<string, string|undefined>} */
  const out = { ...env };
  if (!envUsesPrefixedSecrets(envName, config)) {
    return out;
  }

  const entry = /** @type {Record<string, unknown>|undefined} */ (
    (config.environments || {})[envName]
  );
  const method =
    (entry && typeof entry.method === 'string' && entry.method) ||
    (entry && typeof entry.type === 'string' && entry.type) ||
    null;
  if (!method) return out;

  const keys = getDeploymentWorkflowSecretKeys(
    method,
    /** @type {any} */ (config),
    getEnvSettings(entry)
  );
  for (const key of keys) {
    const prefixed = prefixSecretKey(envName, key);
    if (out[prefixed]) {
      out[key] = out[prefixed];
    } else {
      // Prefixed envs must NOT silently inherit ambient unprefixed leftovers
      // (e.g. shell SSH_HOST from another project). Config settings still win
      // via settings.host || env.SSH_HOST in providers.
      delete out[key];
    }
  }
  return out;
}

/**
 * Workflow secret names for one environment (prefixed only when that env requires it).
 * @param {string} envName
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {Record<string, unknown>} [environments]
 * @returns {string[]}
 */
export function getDeploymentWorkflowSecretKeysForEnv(
  envName,
  deployType,
  config = null,
  environments = null
) {
  const envs = environments || config?.environments || {};
  const settings = getEnvSettings(envs[envName]);
  const keys = getDeploymentWorkflowSecretKeys(deployType, config, settings);
  const cfg = {
    ...(config || {}),
    environments: envs,
  };
  if (!envUsesPrefixedSecrets(envName, cfg)) {
    return keys;
  }
  return keys.map((k) => prefixSecretKey(envName, k));
}

/**
 * Checklist items for one environment (prefixed keys when that env requires it).
 * @param {string} envName
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {Record<string, unknown>} [environments]
 * @returns {SecretChecklistItem[]}
 */
export function getDeploymentSecretChecklistItemsForEnv(
  envName,
  deployType,
  config = null,
  environments = null
) {
  const envs = environments || config?.environments || {};
  const settings = getEnvSettings(envs[envName]);
  const items = getDeploymentSecretChecklistItems(deployType, config, settings);
  const cfg = {
    ...(config || {}),
    environments: environments || config?.environments || {},
  };
  if (!envUsesPrefixedSecrets(envName, cfg)) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    key: prefixSecretKey(envName, item.key),
    note: item.note
      ? `${item.note} (env: ${envName})`
      : `Secret for environment "${envName}"`,
  }));
}

/**
 * Required doctor/CI secret keys for one environment.
 * @param {string} envName
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {Record<string, unknown>} [environments]
 * @returns {string[]}
 */
export function getDeploymentSecretKeysForEnv(
  envName,
  deployType,
  config = null,
  environments = null
) {
  const envs = environments || config?.environments || {};
  const settings = getEnvSettings(envs[envName]);
  const keys = getDeploymentSecretKeys(deployType, config, settings);
  const cfg = {
    ...(config || {}),
    environments: envs,
  };
  if (!envUsesPrefixedSecrets(envName, cfg)) {
    return keys;
  }
  return keys.map((k) => prefixSecretKey(envName, k));
}

/**
 * Unprefixed process-env key ↔ GitHub secret name for one env.
 * @param {string} envName
 * @param {string} unprefixedKey
 * @param {Record<string, unknown>} config
 * @returns {string} secret name to look up in GitHub / doctor
 */
export function resolveSecretNameForEnv(envName, unprefixedKey, config) {
  return envUsesPrefixedSecrets(envName, config)
    ? prefixSecretKey(envName, unprefixedKey)
    : unprefixedKey;
}

/**
 * Format a checklist item for console output.
 * @param {SecretChecklistItem} item
 */
export function formatSecretChecklistLine(item) {
  if (item.required) {
    const note = item.note ? ` — ${item.note}` : '';
    return `• ${item.key} (required${note})`;
  }
  const note = item.note ? ` — ${item.note}` : '';
  return `• ${item.key} (optional${note})`;
}

/**
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {Record<string, Record<string, unknown>>} [environments]
 * @param {{ envName?: string }} [options]
 * @returns {string}
 */
export function generateDeploymentEnvSection(
  deployType,
  config = null,
  environments = {},
  options = {}
) {
  const projectType = config?.projectType || 'frontend';
  const isBackend = projectType === 'backend' || projectType === 'both';
  const envName = options.envName;
  const cfg = {
    ...(config || {}),
    environments: environments || config?.environments || {},
  };
  const shouldPrefix =
    !!envName && envUsesPrefixedSecrets(envName, /** @type {any} */ (cfg));

  const baseTitle = DEPLOYMENT_SECTION_TITLES[deployType] || deployType;
  const title =
    envName && Object.keys(environments || {}).length > 1
      ? `${baseTitle} (${envName})`
      : baseTitle;
  /** @type {string[]} */
  const lines = [`# ${title}`];

  // Prefer defaults from this environment's config when generating per-env sections.
  const envEntry = envName
    ? /** @type {Record<string, unknown>} */ (
        (environments || {})[envName] || {}
      )
    : /** @type {Record<string, unknown>} */ (
        Object.values(environments || {})[0] || {}
      );
  // Support both new { config: {...} } shape and flat legacy env entries.
  const settings =
    envEntry && typeof envEntry.config === 'object' && envEntry.config
      ? /** @type {Record<string, unknown>} */ (envEntry.config)
      : envEntry;

  for (const d of getMethodEnvDefs(deployType, settings)) {
    if (d.when === 'backend' && !isBackend) continue;

    const isOptional = d.when === 'optional' || d.when === 'ci';
    if (isOptional && d.optionalReason) {
      lines.push(`# OPTIONAL — ${d.optionalReason}`);
    }

    for (const line of d.comment) {
      lines.push(`# ${line}`);
    }

    if (d.example) {
      lines.push(`# Example: ${d.example}`);
    }

    const key = shouldPrefix ? prefixSecretKey(envName, d.key) : d.key;
    const defaultVal =
      d.default || getDefaultFromConfig(d.key, config, settings);
    lines.push(defaultVal ? `${key}=${defaultVal}` : `${key}=`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}


/**
 * @param {string} key
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {Record<string, unknown>} [settings]
 */
function getDefaultFromConfig(key, config, settings = {}) {
  const map = {
    SSH_HOST: settings.host,
    SSH_USER: settings.user,
    SSH_DEPLOY_PATH: settings.deployPath || settings.path,
    SSH_APP_NAME: settings.appName,
    SSH_PORT: config?.port || config?.backend?.port,
    SSH_SSH_PORT: '22',
    KUBE_NAMESPACE: settings.kubeNamespace || config?.project || 'default',
    DOCKER_IMAGE_NAME: settings.dockerImageName || config?.project,
    DOCKER_IMAGE_TAG: '',
    DOCKER_REGISTRY_URL: settings.dockerRegistryUrl,
    EC2_LOOKUP_AWS_REGION: settings.awsRegion || 'us-east-1',
  };

  const val = map[key];
  return val !== undefined && val !== null ? String(val) : undefined;
}

/** @type {Record<string, string>} */
export const DEPLOYMENT_SECTION_TITLES = {
  ssh: 'SSH Deployment',
  docker: 'Docker Deployment',
  ec2: 'AWS EC2 Deployment',
  'azure-vm': 'Azure VM Deployment',
  'gcp-vm': 'GCP VM Deployment',
  kubernetes: 'Kubernetes Deployment',
};

/** @type {Record<string, { before: string[], automates: string[], after: string[] }>} */
export const DEPLOYMENT_GUIDE = {
  ssh: {
    before: [
      'A Linux server (VPS, bare metal, or VM) with SSH enabled.',
      'Docker is NOT required on the server unless your app uses it.',
      'Your app runtime installed (Node.js, Python, etc.) for backend deploys.',
      'Port 22 open in the server firewall for SSH from your IP.',
      'An SSH key pair: private key on your machine, public key in server authorized_keys.',
    ],
    automates: [
      'Generates deployhub.config.json and GitHub Actions workflow.',
      'Creates a complete .env.example with inline comments for every variable.',
      'Validates your SSH key file exists and fixes permissions if needed.',
      'Tests SSH connectivity during init (fail fast before first deploy).',
      'Uploads artifact, extracts to deploy path, and restarts your app.',
    ],
    after: [
      'Ensure port 22 (SSH) is open in your server firewall for inbound traffic from your IP.',
      'Copy .env.example to .env and fill in SSH_HOST, SSH_USER, SSH_KEY_PATH.',
      'Add GitHub Secrets: SSH_HOST, SSH_USER, SSH_KEY (paste private key contents for CI).',
      'Run deployhub doctor to verify SSH connectivity and credentials.',
      'git push origin main to trigger your first deployment.',
    ],
  },
  docker: {
    before: [
      'Docker installed locally (docker --version works) — used to build/push images.',
      'For remote Linux via SSH: Docker installed on that host and the SSH user in the docker group.',
      'A Dockerfile or docker-compose.yml in your project (or enable pipeline.docker).',
      'Registry account if pushing to a private registry (Docker Hub, GHCR, etc.).',
    ],
    automates: [
      'Generates config, workflow, and .env.example for registry and image settings.',
      'Generates a starter Dockerfile and .dockerignore when missing.',
      'Offers local Docker, first-class remote SSH (node-ssh), or advanced raw DOCKER_HOST.',
      'Validates SSH key and host when remote.mode is ssh; tests the local daemon otherwise.',
      'Builds the image once during the pipeline docker stage, then reuses it on deploy.',
    ],
    after: [
      'Copy .env.example to .env and set DOCKER_IMAGE_NAME (required — e.g. myuser/myapp).',
      'Remote Linux via SSH: also set SSH_HOST, SSH_USER, SSH_KEY_PATH (same names as EC2).',
      'Advanced raw URI only: DOCKER_HOST, and DOCKER_TLS_VERIFY / DOCKER_CERT_PATH for tcp:// TLS.',
      'If using a private registry: also set DOCKER_REGISTRY_USERNAME and DOCKER_REGISTRY_TOKEN.',
      'Add the GitHub Secrets listed below (Settings → Secrets and variables → Actions). Local .env is NOT used by GitHub Actions — doctor only checks your machine.',
      'Run deployhub doctor to verify Docker (and SSH, when remote.mode is ssh).',
      'git push origin main to trigger your first deployment.',
    ],
  },
  ec2: {
    before: [
      'An EC2 instance already launched in AWS Console (DeployHub does not create instances).',
      'A key pair downloaded (.pem file) when the instance was created.',
      'Security group with inbound SSH (port 22) from your IP.',
      'Instance runtime installed (Node.js, Python, etc.) for backend deploys.',
      'Note the instance public IP or DNS — or set EC2_INSTANCE_ID for auto lookup.',
    ],
    automates: [
      'Generates EC2-specific .env.example with SSH and optional AWS API vars.',
      'Validates SSH key file and tests SSH connectivity during init.',
      'Suggests default SSH user based on AMI (ubuntu, ec2-user, admin).',
      'Optionally resolves public IP from EC2_INSTANCE_ID via AWS API.',
    ],
    after: [
      'AWS Console → EC2 → Security Groups → your instance group → Inbound rules →',
      '  Add rule: SSH, port 22, source: My IP',
      'Copy .env.example to .env — set SSH_KEY_PATH, SSH_HOST (or EC2_INSTANCE_ID + EC2_LOOKUP_AWS_*).',
      'Add GitHub Secrets: SSH_HOST, SSH_USER, SSH_KEY, plus EC2_LOOKUP_AWS_* if using instance ID lookup (distinct from S3 AWS_*).',
      'Run deployhub doctor to verify SSH and optional AWS API access.',
      'git push origin main to trigger your first deployment.',
    ],
  },
  'azure-vm': {
    before: [
      'An Azure VM already created in Azure Portal (DeployHub does not provision VMs).',
      'NSG (Network Security Group) rule allowing inbound SSH (port 22) from your IP.',
      'SSH public key added to the VM (Azure uses ~/.ssh/authorized_keys on the VM).',
      'App runtime installed on the VM for backend deploys.',
    ],
    automates: [
      'Generates Azure VM .env.example with SSH and optional Azure API vars.',
      'Auto-detects subscription ID via az CLI if installed and logged in.',
      'Validates SSH key and tests connectivity during init.',
    ],
    after: [
      'Azure Portal → VM → Networking → Inbound port rules → allow SSH (22) from your IP.',
      'Or: az network nsg rule create --name AllowSSH --priority 1000 --source-address-prefix YOUR_IP ...',
      'Copy .env.example to .env and fill in SSH_HOST, SSH_USER, SSH_KEY_PATH.',
      'For CI: add AZURE_VM_LOOKUP_TENANT_ID, AZURE_VM_LOOKUP_CLIENT_ID, AZURE_VM_LOOKUP_CLIENT_SECRET as GitHub Secrets.',
      'Run deployhub doctor, then git push origin main.',
    ],
  },
  'gcp-vm': {
    before: [
      'A Compute Engine VM already created (DeployHub does not create VMs).',
      'Firewall rule allowing tcp:22 (SSH) — default "default-allow-ssh" may already exist.',
      'SSH access: add your public key in GCP Console → Compute Engine → Metadata → SSH Keys',
      '  (GCP uses project/instance metadata keys, not a launch-time key pair like AWS).',
      'App runtime installed on the VM for backend deploys.',
    ],
    automates: [
      'Generates GCP VM .env.example with SSH and optional GCP API vars.',
      'Auto-detects project ID via gcloud CLI if installed and authenticated.',
      'Validates SSH key and tests connectivity during init.',
    ],
    after: [
      'GCP Console → VPC network → Firewall → ensure ssh (tcp:22) is allowed from your IP.',
      'Or: gcloud compute firewall-rules create allow-ssh --allow tcp:22 --source-ranges YOUR_IP/32',
      'Add your SSH public key in Console → Compute Engine → Metadata → SSH Keys if not done.',
      'Copy .env.example to .env — set SSH_HOST, SSH_USER, SSH_KEY_PATH.',
      'Run deployhub doctor, then git push origin main.',
    ],
  },
  kubernetes: {
    before: [
      'An existing Kubernetes cluster (DeployHub does not provision clusters).',
      'kubectl installed and configured (kubectl cluster-info works).',
      'A container registry account — clusters pull images from a registry, not your local Docker daemon.',
      'Registry credentials (username + token) to push your image so the cluster can pull it.',
      'Kubernetes manifests (Deployment, Service, etc.) in your repo or artifact.',
      'Cluster access from CI: kubeconfig or cloud-specific auth for GitHub Actions.',
    ],
    automates: [
      'Lists available kubectl contexts during init so you pick from a menu.',
      'Auto-detects ~/.kube/config if present.',
      'Generates complete .env.example for kubeconfig, context, namespace, and registry settings.',
      'Tests cluster connectivity during init.',
      'Builds and pushes your container image during deployhub build/deploy (pipeline docker stage).',
    ],
    after: [
      'Ensure your kubeconfig context points to the correct cluster.',
      'Namespace is created on first deploy if missing (prompt locally; auto-create in CI). Or: kubectl create namespace YOUR_NAMESPACE',
      'Copy .env.example to .env and set DOCKER_IMAGE_NAME, DOCKER_REGISTRY_USERNAME, and DOCKER_REGISTRY_TOKEN.',
      'Skipping registry credentials will very likely cause ImagePullBackOff — the cluster cannot see local Docker images.',
      'For private registries: also create kubectl create secret docker-registry ... and set KUBE_IMAGE_PULL_SECRET.',
      'Interpreted backends (Node/Python/PHP/Rails): rollback refuses to rebuild from the artifact when the buildId image is not local — keep pipeline.docker builds so the restored tag exists.',
      'Add the GitHub Secrets listed below (Settings → Secrets and variables → Actions).',
      'Run deployhub doctor to verify cluster access and that your image is pullable.',
      'git push origin main to trigger your first deployment.',
    ],
  },
};

/**
 * @param {string} deployType
 * @param {SecretChecklistItem[]} [checklist]
 */
export function printDeploymentNextSteps(deployType, checklist = []) {
  const guide = DEPLOYMENT_GUIDE[deployType];
  if (!guide) return;

  const title = DEPLOYMENT_SECTION_TITLES[deployType] || deployType;
  console.log(`\n  Next steps before your first deploy (${title}):`);

  guide.after.forEach((step, i) => {
    console.log(`    ${i + 1}. ${step}`);
  });

  if (checklist.length > 0) {
    console.log('\n  GitHub Secrets to add (Settings → Secrets and variables → Actions):');
    for (const item of checklist) {
      console.log(`    ${formatSecretChecklistLine(item)}`);
    }
  }
}
