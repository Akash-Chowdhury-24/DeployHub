/**
 * Canonical credential / env-var inventory for storage × deployment collision audits.
 *
 * Storage lists are the COMPLETE runtime reads from src/storage/providers/*.js
 * (plus schema keys from PROVIDER_ENV_MAP). Deployment lists come from
 * DEPLOYMENT_ENV_DEFS / DEPLOYMENT_ENV_KEYS (the declared complete method sets).
 *
 * Keep this module in sync when adding providers or methods — the matrix test
 * fails if storage and deployment declare overlapping bare names.
 */

import { DEPLOYMENT_ENV_KEYS } from '../deployment/deployment-env.js';

/** Storage provider ids in matrix order. */
export const STORAGE_PROVIDER_ORDER = [
  'aws',
  'azure',
  'gcp',
  'gdrive',
  'dropbox',
  'ftp',
  'local',
];

/** Deployment method ids in matrix order. */
export const DEPLOYMENT_METHOD_ORDER = [
  'ssh',
  'ec2',
  'azure-vm',
  'gcp-vm',
  'docker',
  'kubernetes',
];

/**
 * Complete env vars each storage provider reads at runtime.
 * Local: no credentials — DEPLOYHUB_LOCAL_STORAGE_DIR is an optional test pin only
 * (listed under runtimeExtras, not as a credential).
 *
 * @type {Record<string, string[]>}
 */
export const STORAGE_RUNTIME_ENV_KEYS = {
  aws: [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_BUCKET',
    'AWS_REGION',
  ],
  azure: ['AZURE_CONNECTION_STRING', 'AZURE_CONTAINER'],
  gcp: ['GCP_PROJECT_ID', 'GCP_KEY_FILE', 'GCP_BUCKET'],
  gdrive: [
    'GDRIVE_CLIENT_ID',
    'GDRIVE_CLIENT_SECRET',
    'GDRIVE_REFRESH_TOKEN',
    'GDRIVE_FOLDER_ID',
  ],
  dropbox: ['DROPBOX_ACCESS_TOKEN'],
  ftp: ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD', 'FTP_PORT', 'FTP_PATH'],
  local: [],
};

/**
 * Non-credential runtime extras (optional paths / tuning). Not treated as
 * storage credentials for collision purposes, but tracked for schema-drift docs.
 *
 * @type {Record<string, string[]>}
 */
export const STORAGE_RUNTIME_EXTRAS = {
  local: ['DEPLOYHUB_LOCAL_STORAGE_DIR'],
};

/**
 * Complete declared deployment method env keys (core + optional + CI).
 * @type {Record<string, string[]>}
 */
export const DEPLOYMENT_RUNTIME_ENV_KEYS = {
  ssh: DEPLOYMENT_ENV_KEYS.ssh,
  ec2: DEPLOYMENT_ENV_KEYS.ec2,
  'azure-vm': DEPLOYMENT_ENV_KEYS['azure-vm'],
  'gcp-vm': DEPLOYMENT_ENV_KEYS['gcp-vm'],
  docker: DEPLOYMENT_ENV_KEYS.docker,
  kubernetes: DEPLOYMENT_ENV_KEYS.kubernetes,
};

/**
 * SSH runtime also reads these tuning knobs (not in DEPLOYMENT_ENV_DEFS).
 * Not credentials; listed for inventory completeness.
 */
export const SSH_RUNTIME_TUNING_KEYS = [
  'DEPLOYHUB_SSH_EXEC_TIMEOUT_MS',
  'DEPLOYHUB_SSH_START_TIMEOUT_MS',
];

/**
 * Intentional same-name sharing across deployment methods (same concern).
 * Separated per-environment by the existing secret-prefixing system when
 * multiple environments exist.
 *
 * @type {{ methods: [string, string], keys: string[], reason: string }[]}
 */
export const SHARED_BY_DESIGN_DEPLOY_PAIRS = [
  {
    methods: ['ssh', 'ec2'],
    keys: [
      'SSH_HOST',
      'SSH_USER',
      'SSH_KEY_PATH',
      'SSH_SSH_PORT',
      'SSH_DEPLOY_PATH',
      'SSH_APP_NAME',
      'SSH_PORT',
      'SSH_KEY',
    ],
    reason: 'EC2 wraps SSH after optional host lookup — same SSH concern',
  },
  {
    methods: ['ssh', 'azure-vm'],
    keys: [
      'SSH_HOST',
      'SSH_USER',
      'SSH_KEY_PATH',
      'SSH_SSH_PORT',
      'SSH_DEPLOY_PATH',
      'SSH_APP_NAME',
      'SSH_PORT',
      'SSH_KEY',
    ],
    reason: 'Azure VM wraps SSH after optional host lookup — same SSH concern',
  },
  {
    methods: ['ssh', 'gcp-vm'],
    keys: [
      'SSH_HOST',
      'SSH_USER',
      'SSH_KEY_PATH',
      'SSH_SSH_PORT',
      'SSH_DEPLOY_PATH',
      'SSH_APP_NAME',
      'SSH_PORT',
      'SSH_KEY',
    ],
    reason: 'GCP VM wraps SSH after optional host lookup — same SSH concern',
  },
  {
    methods: ['ec2', 'azure-vm'],
    keys: [
      'SSH_HOST',
      'SSH_USER',
      'SSH_KEY_PATH',
      'SSH_SSH_PORT',
      'SSH_DEPLOY_PATH',
      'SSH_APP_NAME',
      'SSH_PORT',
      'SSH_KEY',
    ],
    reason: 'Both SSH-based cloud VMs share the SSH credential namespace',
  },
  {
    methods: ['ec2', 'gcp-vm'],
    keys: [
      'SSH_HOST',
      'SSH_USER',
      'SSH_KEY_PATH',
      'SSH_SSH_PORT',
      'SSH_DEPLOY_PATH',
      'SSH_APP_NAME',
      'SSH_PORT',
      'SSH_KEY',
    ],
    reason: 'Both SSH-based cloud VMs share the SSH credential namespace',
  },
  {
    methods: ['azure-vm', 'gcp-vm'],
    keys: [
      'SSH_HOST',
      'SSH_USER',
      'SSH_KEY_PATH',
      'SSH_SSH_PORT',
      'SSH_DEPLOY_PATH',
      'SSH_APP_NAME',
      'SSH_PORT',
      'SSH_KEY',
    ],
    reason: 'Both SSH-based cloud VMs share the SSH credential namespace',
  },
  {
    methods: ['docker', 'kubernetes'],
    keys: [
      'DOCKER_IMAGE_NAME',
      'DOCKER_IMAGE_TAG',
      'DOCKER_REGISTRY_URL',
      'DOCKER_REGISTRY_USERNAME',
      'DOCKER_REGISTRY_TOKEN',
    ],
    reason:
      'Same container-registry concern — Kubernetes builds/pushes via the same Docker image helpers',
  },
];

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {string[]}
 */
export function intersectKeys(a, b) {
  const setB = new Set(b);
  return a.filter((k) => setB.has(k)).sort();
}

/**
 * Every storage × deployment overlap cell.
 * Empty array = no overlap.
 *
 * @returns {Record<string, Record<string, string[]>>}
 */
export function buildStorageDeployOverlapMatrix() {
  /** @type {Record<string, Record<string, string[]>>} */
  const matrix = {};
  for (const storageId of STORAGE_PROVIDER_ORDER) {
    matrix[storageId] = {};
    const storageKeys = STORAGE_RUNTIME_ENV_KEYS[storageId] || [];
    for (const method of DEPLOYMENT_METHOD_ORDER) {
      const deployKeys = DEPLOYMENT_RUNTIME_ENV_KEYS[method] || [];
      matrix[storageId][method] = intersectKeys(storageKeys, deployKeys);
    }
  }
  return matrix;
}

/**
 * Flatten all unintended storage×deploy collisions (should be empty).
 * @returns {{ storage: string, method: string, keys: string[] }[]}
 */
export function listStorageDeployCollisions() {
  const matrix = buildStorageDeployOverlapMatrix();
  /** @type {{ storage: string, method: string, keys: string[] }[]} */
  const hits = [];
  for (const storageId of STORAGE_PROVIDER_ORDER) {
    for (const method of DEPLOYMENT_METHOD_ORDER) {
      const keys = matrix[storageId][method];
      if (keys.length > 0) {
        hits.push({ storage: storageId, method, keys });
      }
    }
  }
  return hits;
}

/**
 * Deploy×deploy shared keys, classified against SHARED_BY_DESIGN_DEPLOY_PAIRS.
 * @returns {{ a: string, b: string, keys: string[], designed: boolean, reason?: string }[]}
 */
export function listDeployDeployShares() {
  /** @type {{ a: string, b: string, keys: string[], designed: boolean, reason?: string }[]} */
  const rows = [];
  for (let i = 0; i < DEPLOYMENT_METHOD_ORDER.length; i++) {
    for (let j = i + 1; j < DEPLOYMENT_METHOD_ORDER.length; j++) {
      const a = DEPLOYMENT_METHOD_ORDER[i];
      const b = DEPLOYMENT_METHOD_ORDER[j];
      const keys = intersectKeys(
        DEPLOYMENT_RUNTIME_ENV_KEYS[a] || [],
        DEPLOYMENT_RUNTIME_ENV_KEYS[b] || []
      );
      if (keys.length === 0) continue;
      const designed = SHARED_BY_DESIGN_DEPLOY_PAIRS.find(
        (p) =>
          (p.methods[0] === a && p.methods[1] === b) ||
          (p.methods[0] === b && p.methods[1] === a)
      );
      const unexpected = designed
        ? keys.filter((k) => !designed.keys.includes(k))
        : keys;
      rows.push({
        a,
        b,
        keys,
        designed: Boolean(designed) && unexpected.length === 0,
        reason: designed?.reason,
      });
      if (designed && unexpected.length > 0) {
        rows.push({
          a,
          b,
          keys: unexpected,
          designed: false,
          reason: `unexpected share beyond designed set for ${a}∩${b}`,
        });
      }
    }
  }
  return rows;
}
