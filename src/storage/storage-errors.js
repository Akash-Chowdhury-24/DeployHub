/**
 * Shared helpers for storage provider errors (history load, verify, etc.).
 */

/**
 * Concise, actionable one-line reason — no SDK stack dumps.
 * @param {unknown} err
 * @returns {string}
 */
export function summarizeStorageError(err) {
  if (!err) return 'unknown error';

  if (typeof err === 'string') {
    return truncateReason(err);
  }

  const e = /** @type {Record<string, unknown>} */ (err);
  const name = typeof e.name === 'string' ? e.name : '';
  const code =
    typeof e.Code === 'string'
      ? e.Code
      : typeof e.code === 'string'
        ? e.code
        : '';
  const message =
    err instanceof Error
      ? err.message
      : typeof e.message === 'string'
        ? e.message
        : String(err);

  const firstLine = message.split(/\r?\n/)[0].trim();

  // Prefer a short "AccessDenied: ..." style when the SDK exposes a name/code.
  const label = [name, code].find(
    (v) => v && v !== 'Error' && !firstLine.includes(v)
  );
  const combined = label ? `${label}: ${firstLine}` : firstLine;
  return truncateReason(combined || 'unknown error');
}

/**
 * @param {string} text
 */
function truncateReason(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 200) return cleaned;
  return `${cleaned.slice(0, 197)}...`;
}

/**
 * True when an error almost certainly means the object/key is missing
 * (as opposed to auth, network, or permission failures).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isNotFoundStorageError(err) {
  if (!err || typeof err !== 'object') return false;
  const e = /** @type {Record<string, unknown>} */ (err);
  const status =
    (e.$metadata &&
      typeof e.$metadata === 'object' &&
      /** @type {{ httpStatusCode?: number }} */ (e.$metadata).httpStatusCode) ||
    (typeof e.statusCode === 'number' ? e.statusCode : undefined) ||
    (typeof e.status === 'number' ? e.status : undefined);

  const name = String(e.name || e.Code || e.code || '');
  const msg = String(e.message || '').toLowerCase();
  const blob = `${name} ${msg}`;

  // Auth / permission / credential failures are never "not found"
  if (
    /\b(accessdenied|access denied|invalidaccesskey|forbidden|unauthorized|credentials|signaturedoesnotmatch|expiredtoken)\b/i.test(
      blob
    )
  ) {
    return false;
  }

  if (status === 403 || status === 401) return false;

  if (status === 404) return true;

  if (/^(NoSuchKey|NotFound|NotFoundError|ENOENT)$/i.test(name)) return true;

  if (
    /\b(nosuchkey|not\s*found|no such file|path\/not_found)\b/i.test(msg) ||
    /\bthe specified key does not exist\b/i.test(msg)
  ) {
    return true;
  }

  // Dropbox often uses 409 with path/not_found
  if (status === 409 && /not_found/i.test(msg + name + JSON.stringify(e.error || ''))) {
    return true;
  }

  // FTP / classic responses
  if (/\b550\b/.test(msg) && /not found|no such|failed to open/i.test(msg)) {
    return true;
  }

  return false;
}

export default { summarizeStorageError, isNotFoundStorageError };
