/**
 * Central source of truth for deployment method env vars, documentation,
 * and post-init next steps.
 */

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
      'Process name used by PM2 when restarting your Node.js backend.',
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
      optionalReason: 'defaults to your project version if unset',
      comment: ['Image tag to build and deploy.'],
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
      optionalReason: 'only required when deploying to a remote Docker daemon instead of local Docker',
      comment: [
        'Remote Docker daemon address.',
        'Examples: ssh://ubuntu@203.0.113.10 | tcp://203.0.113.10:2376',
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
      key: 'AWS_ACCESS_KEY_ID',
      optionalReason:
        'only required if using EC2_INSTANCE_ID for dynamic IP lookup; otherwise leave blank',
      comment: [
        'AWS access key with ec2:DescribeInstances permission.',
        'Create in AWS Console → IAM → Users → Security credentials.',
      ],
      when: 'optional',
    },
    {
      key: 'AWS_SECRET_ACCESS_KEY',
      optionalReason:
        'only required if using EC2_INSTANCE_ID for dynamic IP lookup; otherwise leave blank',
      comment: ['Secret for the AWS access key above.'],
      when: 'optional',
    },
    {
      key: 'AWS_REGION',
      optionalReason:
        'only required if using EC2_INSTANCE_ID for dynamic IP lookup; otherwise leave blank',
      comment: ['AWS region where your EC2 instance runs.'],
      example: 'us-east-1',
      when: 'optional',
    },
  ],
  'azure-vm': [
    ...SSH_BASE_ENV_VARS,
    ...SSH_BACKEND_ENV_VARS,
    ...SSH_CI_ENV_VARS,
    {
      key: 'AZURE_SUBSCRIPTION_ID',
      optionalReason:
        'only required for dynamic VM IP lookup via Azure API; otherwise set SSH_HOST directly',
      comment: [
        'Azure subscription ID. Used to look up VM public IP via Azure API.',
        'Find in Azure Portal → Subscriptions, or run: az account show --query id -o tsv',
      ],
      when: 'optional',
    },
    {
      key: 'AZURE_RESOURCE_GROUP',
      optionalReason:
        'only required for dynamic VM IP lookup via Azure API; otherwise leave blank',
      comment: ['Resource group containing your VM.'],
      example: 'my-app-rg',
      when: 'optional',
    },
    {
      key: 'AZURE_VM_NAME',
      optionalReason:
        'only required for dynamic VM IP lookup via Azure API; otherwise set SSH_HOST directly',
      comment: [
        'Name of the Azure virtual machine.',
        'If unset, SSH_HOST must be set to the VM public IP or DNS.',
      ],
      when: 'optional',
    },
    {
      key: 'AZURE_TENANT_ID',
      optionalReason:
        'only required for non-interactive CI deploys (GitHub Actions) using a service principal',
      comment: ['Azure AD tenant ID for service principal auth in CI.'],
      when: 'optional',
    },
    {
      key: 'AZURE_CLIENT_ID',
      optionalReason:
        'only required for non-interactive CI deploys (GitHub Actions) using a service principal',
      comment: ['Service principal application (client) ID for CI auth.'],
      when: 'optional',
    },
    {
      key: 'AZURE_CLIENT_SECRET',
      optionalReason:
        'only required for non-interactive CI deploys (GitHub Actions) using a service principal',
      comment: ['Service principal client secret for CI auth.'],
      when: 'optional',
    },
  ],
  'gcp-vm': [
    ...SSH_BASE_ENV_VARS,
    ...SSH_BACKEND_ENV_VARS,
    ...SSH_CI_ENV_VARS,
    {
      key: 'GCP_PROJECT_ID',
      optionalReason:
        'only required for dynamic VM IP lookup via GCP API; otherwise set SSH_HOST directly',
      comment: [
        'GCP project ID. Used to look up VM IP via Compute API.',
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
      key: 'GCP_KEY_FILE',
      optionalReason:
        'only required for dynamic VM IP lookup via GCP API or non-interactive CI auth; otherwise leave blank',
      comment: [
        'Path to a GCP service account JSON key file.',
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
        'Create one first if needed: kubectl create namespace my-app',
      ],
      example: 'my-app',
      when: 'optional',
    },
    {
      key: 'DOCKER_IMAGE_NAME',
      optionalReason: 'only required if your manifests need an image override at deploy time',
      comment: [
        'Container image to deploy (must match manifests or be overridden).',
      ],
      example: 'ghcr.io/myorg/myapp',
      when: 'optional',
    },
    {
      key: 'DOCKER_IMAGE_TAG',
      optionalReason: 'defaults to your project version, then "latest" if unset',
      comment: [
        'Image tag written into generated manifests and used at deploy time.',
      ],
      example: 'latest',
      when: 'optional',
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

/**
 * Locally required env keys for doctor method-specific checks.
 * Excludes optional and CI-only vars.
 * @param {string} deployType
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string[]}
 */
export function getDeploymentEnvKeys(deployType, config = null) {
  const defs = DEPLOYMENT_ENV_DEFS[deployType] || [];
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
export function getDeploymentSecretKeys(deployType, config = null) {
  const defs = DEPLOYMENT_ENV_DEFS[deployType] || [];
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
export function getDeploymentWorkflowSecretKeys(deployType, config = null) {
  const defs = DEPLOYMENT_ENV_DEFS[deployType] || [];
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
export function getDeploymentSecretChecklistItems(deployType, config = null) {
  const defs = DEPLOYMENT_ENV_DEFS[deployType] || [];
  const projectType = config?.projectType || 'frontend';
  const isBackend = projectType === 'backend' || projectType === 'both';

  /** @type {Map<string, SecretChecklistItem>} */
  const byKey = new Map();

  for (const d of defs) {
    if (d.when === 'backend' && !isBackend) continue;

    const key = toGithubSecretKey(d.key);
    const required = d.when !== 'optional';
    const note =
      d.when === 'optional'
        ? d.optionalReason
        : d.when === 'ci'
          ? d.optionalReason || 'required for GitHub Actions CI (paste private key contents)'
          : undefined;

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
 * @returns {string}
 */
export function generateDeploymentEnvSection(
  deployType,
  config = null,
  environments = {}
) {
  const defs = DEPLOYMENT_ENV_DEFS[deployType] || [];
  const projectType = config?.projectType || 'frontend';
  const isBackend = projectType === 'backend' || projectType === 'both';

  const title = DEPLOYMENT_SECTION_TITLES[deployType] || deployType;
  /** @type {string[]} */
  const lines = [`# ${title}`];

  for (const d of defs) {
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

    const defaultVal = d.default || getDefaultFromConfig(d.key, config, environments);
    lines.push(defaultVal ? `${d.key}=${defaultVal}` : `${d.key}=`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}


/**
 * @param {string} key
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @param {Record<string, Record<string, unknown>>} [environments]
 */
function getDefaultFromConfig(key, config, environments) {
  const envEntry = Object.values(environments || {})[0] || {};

  const map = {
    SSH_HOST: envEntry.host,
    SSH_USER: envEntry.user,
    SSH_DEPLOY_PATH: envEntry.deployPath || envEntry.path,
    SSH_APP_NAME: envEntry.appName,
    SSH_PORT: config?.port || config?.backend?.port,
    SSH_SSH_PORT: '22',
    KUBE_NAMESPACE: config?.project || 'default',
    DOCKER_IMAGE_NAME: config?.project,
    DOCKER_IMAGE_TAG: config?.version || 'latest',
    DOCKER_REGISTRY_URL: envEntry.dockerRegistryUrl,
    AWS_REGION: 'us-east-1',
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
      'Docker installed locally (docker --version works).',
      'If deploying to a remote host: Docker installed on that host and reachable.',
      'A Dockerfile or docker-compose.yml in your project (or enable pipeline.docker).',
      'Registry account if pushing to a private registry (Docker Hub, GHCR, etc.).',
    ],
    automates: [
      'Generates config, workflow, and .env.example for registry and image settings.',
      'Generates a starter Dockerfile and .dockerignore when missing.',
      'Tests Docker daemon connectivity during init.',
      'Builds the image once during the pipeline docker stage, then reuses it on deploy.',
    ],
    after: [
      'Copy .env.example to .env and set DOCKER_IMAGE_NAME (required — e.g. myuser/myapp).',
      'Optional in .env: DOCKER_IMAGE_TAG, DOCKER_REGISTRY_URL, DOCKER_HOST, DOCKER_TLS_VERIFY, DOCKER_CERT_PATH.',
      'If using a private registry: also set DOCKER_REGISTRY_USERNAME and DOCKER_REGISTRY_TOKEN.',
      'Add the GitHub Secrets listed below (Settings → Secrets and variables → Actions). Local .env is NOT used by GitHub Actions — doctor only checks your machine.',
      'Run deployhub doctor to verify Docker is reachable.',
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
      'Copy .env.example to .env — set SSH_KEY_PATH, SSH_HOST (or EC2_INSTANCE_ID + AWS creds).',
      'Add GitHub Secrets: SSH_HOST, SSH_USER, SSH_KEY, plus AWS_* if using instance ID lookup.',
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
      'For CI: add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET as GitHub Secrets.',
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
      'Kubernetes manifests (Deployment, Service, etc.) in your repo or artifact.',
      'Cluster access from CI: kubeconfig or cloud-specific auth for GitHub Actions.',
    ],
    automates: [
      'Lists available kubectl contexts during init so you pick from a menu.',
      'Auto-detects ~/.kube/config if present.',
      'Generates complete .env.example for kubeconfig, context, and namespace.',
      'Tests cluster connectivity during init.',
    ],
    after: [
      'Ensure your kubeconfig context points to the correct cluster.',
      'Create namespace if needed: kubectl create namespace YOUR_NAMESPACE',
      'For private registries: kubectl create secret docker-registry ... and set KUBE_IMAGE_PULL_SECRET.',
      'Copy .env.example to .env; add KUBECONFIG contents or auth secrets to GitHub Actions.',
      'Run deployhub doctor, then git push origin main.',
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
