import {
  parseArtifactHistory,
  prependHistoryEntry,
  resolveRollbackTarget,
  formatAmbiguousRollbackMatches,
} from '../src/utils/artifact-history.js';

const e = (buildId, semver, uploadedAt = '2026-07-26T10:00:00.000Z') => ({
  buildId,
  semver,
  uploadedAt,
  remoteKey: `app/builds/${buildId}/artifact.zip`,
});

describe('artifact history + rollback resolution', () => {
  test('prependHistoryEntry puts newest first and dedupes buildId', () => {
    const hist = [e('1.0.0-aaa', '1.0.0')];
    const next = prependHistoryEntry(hist, e('1.0.0-bbb', '1.0.0', '2026-07-26T11:00:00.000Z'));
    expect(next[0].buildId).toBe('1.0.0-bbb');
    expect(next).toHaveLength(2);
  });

  test('parseArtifactHistory tolerates junk', () => {
    expect(parseArtifactHistory('not-json')).toEqual([]);
    expect(parseArtifactHistory('[]')).toEqual([]);
  });

  test('rollback with no arg picks previous build (history[1])', () => {
    const history = [
      e('1.0.0-bbb', '1.0.0', '2026-07-26T11:00:00.000Z'),
      e('1.0.0-aaa', '1.0.0', '2026-07-26T10:00:00.000Z'),
    ];
    const r = resolveRollbackTarget(history);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.buildId).toBe('1.0.0-aaa');
  });

  test('rollback with exact buildId', () => {
    const history = [
      e('1.0.0-bbb', '1.0.0'),
      e('1.0.0-aaa', '1.0.0'),
      e('0.9.0-zzz', '0.9.0'),
    ];
    const r = resolveRollbackTarget(history, '0.9.0-zzz');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.buildId).toBe('0.9.0-zzz');
  });

  test('rollback with ambiguous semver requires exact buildId (no silent pick)', () => {
    const history = [
      e('1.0.0-ccc', '1.0.0', 't3'),
      e('1.0.0-bbb', '1.0.0', 't2'),
      e('1.0.0-aaa', '1.0.0', 't1'),
    ];
    const r = resolveRollbackTarget(history, 'v1.0.0');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.matches?.map((m) => m.buildId)).toEqual(['1.0.0-bbb', '1.0.0-aaa']);
      expect(formatAmbiguousRollbackMatches(r.matches || [])).toContain('1.0.0-bbb');
    }
  });

  test('rollback with unambiguous semver (exactly one non-current) auto-resolves', () => {
    const history = [
      e('1.1.0-new', '1.1.0', 't2'),
      e('1.0.0-old', '1.0.0', 't1'),
    ];
    const r = resolveRollbackTarget(history, '1.0.0');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.buildId).toBe('1.0.0-old');
  });

  test('rollback no-arg fails when only one history entry', () => {
    const r = resolveRollbackTarget([e('1.0.0-only', '1.0.0')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-previous');
  });
});
