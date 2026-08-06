/**
 * Unique per-build identity shared by artifact storage keys and (when unset)
 * Docker image tags.
 */

import { execFileSync } from 'child_process';

/** @typedef {'git'|'ci'|'timestamp'} BuildStampSource */

/**
 * High-resolution timestamp stamp (seconds+ms) for uniqueness in fast rebuild loops.
 * @param {Date} [now]
 * @returns {string}
 */
export function highResBuildStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${y}.${m}.${d}.${h}${min}-${sec}${ms}`;
}

/**
 * @returns {string|null}
 */
function defaultGetGitShortSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Unique build stamp: git SHA → CI id → high-res timestamp.
 * Does not read DOCKER_IMAGE_TAG (explicit image tags stay separate from artifact identity).
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{
 *   getGitShortSha?: () => string|null,
 *   now?: () => Date,
 * }} [options]
 * @returns {{ stamp: string, source: BuildStampSource }}
 */
export function resolveUniqueBuildStamp(env = process.env, options = {}) {
  const getGitShortSha = options.getGitShortSha || defaultGetGitShortSha;
  const gitSha = getGitShortSha();
  if (gitSha) {
    return { stamp: gitSha, source: 'git' };
  }

  const ciTag =
    (env.GITHUB_SHA && String(env.GITHUB_SHA).slice(0, 7)) ||
    env.GITHUB_RUN_ID ||
    env.CI_COMMIT_SHORT_SHA ||
    env.CI_PIPELINE_ID;
  if (ciTag) {
    return { stamp: String(ciTag), source: 'ci' };
  }

  const now = options.now ? options.now() : new Date();
  return { stamp: highResBuildStamp(now), source: 'timestamp' };
}

/**
 * Sanitize for use in paths and image tags.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeBuildIdPart(value) {
  return String(value)
    .replace(/^v/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'build';
}

/**
 * @param {{
 *   semver?: string,
 *   env?: Record<string, string|undefined>,
 *   getGitShortSha?: () => string|null,
 *   now?: () => Date,
 * }} [options]
 * @returns {{ buildId: string, semver: string, stamp: string, source: BuildStampSource }}
 */
export function resolveBuildId(options = {}) {
  const env = options.env || process.env;
  const semver = sanitizeBuildIdPart(options.semver || '0.0.0');
  const { stamp, source } = resolveUniqueBuildStamp(env, options);
  const safeStamp = sanitizeBuildIdPart(stamp);
  return {
    buildId: `${semver}-${safeStamp}`,
    semver,
    stamp: safeStamp,
    source,
  };
}

/**
 * Remote key for an immutable build artifact.
 * @param {string} project
 * @param {string} buildId
 */
export function buildArtifactRemoteKey(project, buildId) {
  return `${project}/builds/${buildId}/artifact.zip`;
}

/**
 * Mutable pointer overwritten every upload (not a backup slot).
 * @param {string} project
 */
export function latestArtifactRemoteKey(project) {
  return `${project}/latest/artifact.zip`;
}

/**
 * Project-wide build catalog (newest-first). Legacy pre-multi-env history;
 * also still written on upload as the available-builds index for `artifact list --remote`.
 * Per-environment deploy history lives under envs/{env}/history.json.
 * @param {string} project
 */
export function historyRemoteKey(project) {
  return `${project}/history.json`;
}

/**
 * Per-environment deploy history (newest-first). Rollback resolves against this only.
 * @param {string} project
 * @param {string} envName
 */
export function envHistoryRemoteKey(project, envName) {
  return `${project}/envs/${sanitizeBuildIdPart(envName)}/history.json`;
}

/**
 * Per-environment "currently deployed" pointer (NOT a backup — same semantics as project latest/).
 * @param {string} project
 * @param {string} envName
 */
export function envLatestArtifactRemoteKey(project, envName) {
  return `${project}/envs/${sanitizeBuildIdPart(envName)}/latest/artifact.zip`;
}

/**
 * Pre-buildId legacy key (read-only fallback; never written by new uploads).
 * @param {string} project
 * @param {string} semver
 */
export function legacyArtifactRemoteKey(project, semver) {
  return `${project}/v${sanitizeBuildIdPart(semver)}/artifact.zip`;
}

export default {
  highResBuildStamp,
  resolveUniqueBuildStamp,
  resolveBuildId,
  sanitizeBuildIdPart,
  buildArtifactRemoteKey,
  latestArtifactRemoteKey,
  historyRemoteKey,
  envHistoryRemoteKey,
  envLatestArtifactRemoteKey,
  legacyArtifactRemoteKey,
};
