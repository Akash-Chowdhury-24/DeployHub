/**
 * Artifact upload history (newest-first) and rollback target resolution.
 */

/**
 * @typedef {{
 *   buildId: string,
 *   semver: string,
 *   uploadedAt: string,
 *   remoteKey: string,
 * }} ArtifactHistoryEntry
 */

/**
 * @param {string|unknown} raw
 * @returns {ArtifactHistoryEntry[]}
 */
export function parseArtifactHistory(raw) {
  if (!raw) return [];
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(data)) return [];
    return data
      .filter(
        (e) =>
          e &&
          typeof e === 'object' &&
          typeof e.buildId === 'string' &&
          typeof e.remoteKey === 'string'
      )
      .map((e) => ({
        buildId: String(e.buildId),
        semver: String(e.semver || '').replace(/^v/i, '') || '0.0.0',
        uploadedAt: String(e.uploadedAt || ''),
        remoteKey: String(e.remoteKey),
      }));
  } catch {
    return [];
  }
}

/**
 * @param {ArtifactHistoryEntry[]} history
 * @param {ArtifactHistoryEntry} entry
 * @returns {ArtifactHistoryEntry[]}
 */
export function prependHistoryEntry(history, entry) {
  const filtered = history.filter((e) => e.buildId !== entry.buildId);
  return [entry, ...filtered];
}

/**
 * @param {string} input
 * @returns {string}
 */
export function normalizeVersionArg(input) {
  return String(input || '')
    .trim()
    .replace(/^v/i, '');
}

/**
 * Resolve which history entry to roll back to.
 *
 * @param {ArtifactHistoryEntry[]} history newest-first
 * @param {string} [versionOrBuildId] omitted = previous build (history[1])
 * @returns {{
 *   ok: true,
 *   entry: ArtifactHistoryEntry,
 * } | {
 *   ok: false,
 *   reason: 'empty'|'no-previous'|'not-found'|'ambiguous',
 *   message: string,
 *   matches?: ArtifactHistoryEntry[],
 * }}
 */
export function resolveRollbackTarget(history, versionOrBuildId) {
  if (!history.length) {
    return {
      ok: false,
      reason: 'empty',
      message: 'No artifact history found in storage. Deploy at least once first.',
    };
  }

  if (!versionOrBuildId) {
    if (history.length < 2) {
      return {
        ok: false,
        reason: 'no-previous',
        message: 'No previous build available for rollback (only one build in history).',
      };
    }
    return { ok: true, entry: history[1] };
  }

  const needle = normalizeVersionArg(versionOrBuildId);

  const exact = history.find((e) => e.buildId === needle || e.buildId === versionOrBuildId);
  if (exact) {
    return { ok: true, entry: exact };
  }

  const current = history[0];
  const semverMatches = history.filter(
    (e) => e.semver === needle || `v${e.semver}` === String(versionOrBuildId).trim()
  );

  if (semverMatches.length === 0) {
    return {
      ok: false,
      reason: 'not-found',
      message: `No artifact found for '${versionOrBuildId}'. Use an exact buildId from: deployhub artifact list --remote`,
    };
  }

  const nonCurrent = semverMatches.filter((e) => e.buildId !== current.buildId);

  if (nonCurrent.length === 1) {
    return { ok: true, entry: nonCurrent[0] };
  }

  if (nonCurrent.length === 0) {
    return {
      ok: false,
      reason: 'not-found',
      message: `Only the current build matches semver '${needle}' (${current.buildId}). Nothing to roll back to for that label.`,
    };
  }

  return {
    ok: false,
    reason: 'ambiguous',
    message: `Multiple builds match semver '${needle}'. Re-run with an exact buildId:`,
    matches: nonCurrent,
  };
}

/**
 * @param {ArtifactHistoryEntry[]} matches
 * @returns {string}
 */
export function formatAmbiguousRollbackMatches(matches) {
  return matches
    .map((e) => `  ${e.buildId}  uploadedAt=${e.uploadedAt || '(unknown)'}  key=${e.remoteKey}`)
    .join('\n');
}

export default {
  parseArtifactHistory,
  prependHistoryEntry,
  normalizeVersionArg,
  resolveRollbackTarget,
  formatAmbiguousRollbackMatches,
};
