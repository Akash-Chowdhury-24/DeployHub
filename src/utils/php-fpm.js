/**
 * PHP-FPM systemd unit naming for SSH deploys / doctor.
 * Debian/Ubuntu: php8.4-fpm; Amazon Linux/RHEL: often plain php-fpm.
 */

import { resolvePhpVersion } from './php-version.js';

/**
 * @param {string} phpVersion — e.g. "8.4"
 * @returns {string} — e.g. "php8.4-fpm"
 */
export function preferredPhpFpmUnitName(phpVersion) {
  const v = String(phpVersion || '').trim();
  return `php${v}-fpm`;
}

/**
 * Shell command that lists installed php-fpm unit basenames (one per line).
 * Uses unit-files so inactive-but-installed units still appear.
 * @returns {string}
 */
export function buildPhpFpmUnitListCommand() {
  // sudo -n: unprivileged SSH users cannot talk to systemd's private bus
  // (Failed to connect to bus) inside containers and some hardened hosts.
  return (
    `sudo -n systemctl list-unit-files --type=service --no-legend ` +
    `'php*-fpm.service' 'php-fpm.service' 2>/dev/null ` +
    `| awk '{print $1}' | sed 's/\\.service$//' | sort -u`
  );
}

/**
 * @param {string} stdout
 * @returns {string[]}
 */
export function parsePhpFpmUnitList(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  /** @type {Set<string>} */
  const units = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    // list-unit-files: "php8.4-fpm.service  enabled" — first column only
    const first = raw.split(/\s+/)[0] || '';
    const name = first.replace(/\.service$/i, '');
    if (!name) continue;
    if (name === 'php-fpm' || /^php[\d.]+-fpm$/i.test(name)) {
      units.add(name === 'php-fpm' ? 'php-fpm' : name);
    }
  }
  return [...units];
}


/**
 * @typedef {{ unit: string, match: 'exact'|'generic'|'other-version' }} PhpFpmUnitPick
 */

/**
 * Prefer versioned unit (Debian/Ubuntu), then generic php-fpm (RHEL/AL),
 * else surface another versioned unit as a mismatch (do not silently use it
 * for restart — caller decides whether to error).
 *
 * @param {string[]} availableUnits
 * @param {string} phpVersion
 * @returns {PhpFpmUnitPick | null}
 */
export function pickPhpFpmUnitName(availableUnits, phpVersion) {
  const preferred = preferredPhpFpmUnitName(phpVersion);
  const normalized = availableUnits.map((u) => u.trim()).filter(Boolean);
  if (normalized.includes(preferred)) {
    return { unit: preferred, match: 'exact' };
  }
  if (normalized.includes('php-fpm')) {
    return { unit: 'php-fpm', match: 'generic' };
  }
  const other = normalized.find((u) => /^php[\d.]+-fpm$/i.test(u));
  if (other) {
    return { unit: other, match: 'other-version' };
  }
  return null;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} [config]
 * @returns {string}
 */
export function resolvePreferredPhpFpmUnit(config) {
  return preferredPhpFpmUnitName(resolvePhpVersion(config));
}

/**
 * @param {string} phpVersion
 * @param {string[]} [foundUnits]
 * @returns {string}
 */
export function formatPhpFpmMissingError(phpVersion, foundUnits = []) {
  const preferred = preferredPhpFpmUnitName(phpVersion);
  const found =
    foundUnits.length > 0 ? ` Found unit(s): ${foundUnits.join(', ')}.` : '';
  return (
    `No usable php-fpm systemd service for PHP ${phpVersion} ` +
    `(looked for ${preferred} then php-fpm).${found} ` +
    `Install PHP-FPM matching the project (Ubuntu/Debian: sudo apt install ${preferred}; ` +
    `Amazon Linux/RHEL: often sudo yum install php-fpm) or set phpVersion / backend.phpVersion ` +
    `in deployhub.config.json to match the server, then re-run.`
  );
}

/**
 * @param {string} phpVersion
 * @param {string} foundUnit
 * @returns {string}
 */
export function formatPhpFpmVersionMismatchError(phpVersion, foundUnit) {
  const preferred = preferredPhpFpmUnitName(phpVersion);
  return (
    `Server has ${foundUnit} active/installed, but this project expects PHP ${phpVersion} ` +
    `(service ${preferred}, or generic php-fpm on RHEL/Amazon Linux). ` +
    `Install ${preferred} / matching PHP ${phpVersion}, or set phpVersion in deployhub.config.json ` +
    `to match the server before deploy.`
  );
}

/**
 * Parse `php -v` / `PHP 8.4.1 (cli)...` style output to major.minor.
 * @param {string} phpVOutput
 * @returns {string|null} e.g. "8.4"
 */
export function parsePhpMajorMinor(phpVOutput) {
  if (!phpVOutput || typeof phpVOutput !== 'string') return null;
  const m = phpVOutput.match(/\bPHP\s+(\d+)\.(\d+)/i);
  if (!m) return null;
  return `${m[1]}.${m[2]}`;
}
