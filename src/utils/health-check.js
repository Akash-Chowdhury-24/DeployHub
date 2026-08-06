import axios from 'axios';
import { getEnvSettings } from '../core/environments.js';

/**
 * Per-environment health URL: `environments.{env}.config.healthCheckUrl`, else top-level fallback.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {string}
 */
export function resolveEnvHealthCheckUrl(config, envName) {
  const env = config.environments?.[envName];
  const settings = getEnvSettings(env);
  const override = settings.healthCheckUrl;
  if (typeof override === 'string' && override.trim()) {
    return override.trim();
  }
  const fallback = config.healthCheck?.url;
  return typeof fallback === 'string' && fallback.trim() ? fallback.trim() : '';
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string[]} envNames
 * @returns {boolean}
 */
export function anyEnvHasResolvableHealthCheckUrl(config, envNames) {
  return (envNames || []).some((name) => Boolean(resolveEnvHealthCheckUrl(config, name)));
}

/**
 * @param {number} status
 * @returns {boolean}
 */
export function isHealthyHttpStatus(status) {
  return status >= 200 && status < 400;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {{ httpGet?: (url: string, timeoutMs: number) => Promise<{ status: number }> }} [options]
 * @returns {Promise<{ ok: true, envName: string, url: string, status: number, elapsed: number } | { ok: false, envName: string, url: string, error: string }>}
 */
export async function checkEnvHealth(config, envName, options = {}) {
  const url = resolveEnvHealthCheckUrl(config, envName);
  if (!url) {
    return { ok: false, envName, url: '', error: `No health check URL configured for environment "${envName}"` };
  }

  const timeoutMs = (config.healthCheck?.timeout || 30) * 1000;
  const httpGet =
    options.httpGet ||
    (async (target, ms) => {
      const response = await axios.get(target, {
        timeout: ms,
        validateStatus: () => true,
      });
      return { status: response.status };
    });

  const start = Date.now();
  try {
    const { status } = await httpGet(url, timeoutMs);
    const elapsed = Date.now() - start;
    if (!isHealthyHttpStatus(status)) {
      return {
        ok: false,
        envName,
        url,
        error: `Health check failed for ${envName}: HTTP ${status} (${elapsed}ms) — ${url}`,
      };
    }
    return { ok: true, envName, url, status, elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      envName,
      url,
      error: `Health check failed for ${envName}: ${detail} (${elapsed}ms) — ${url}`,
    };
  }
}

/**
 * Run health checks for each deployed environment independently (checks all, then summarizes).
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string[]} envNames
 * @param {{ httpGet?: (url: string, timeoutMs: number) => Promise<{ status: number }> }} [options]
 */
export async function runHealthChecksForEnvs(config, envNames, options = {}) {
  /** @type {{ envName: string, url: string, status: number, elapsed: number }[]} */
  const results = [];
  /** @type {{ envName: string, url: string, error: string }[]} */
  const failures = [];

  for (const envName of envNames || []) {
    const url = resolveEnvHealthCheckUrl(config, envName);
    if (!url) continue;

    const outcome = await checkEnvHealth(config, envName, options);
    if (outcome.ok) {
      results.push({
        envName: outcome.envName,
        url: outcome.url,
        status: outcome.status,
        elapsed: outcome.elapsed,
      });
    } else {
      failures.push({
        envName: outcome.envName,
        url: outcome.url,
        error: outcome.error,
      });
    }
  }

  return { results, failures };
}

/**
 * @param {{ envName: string, url: string, status: number, elapsed: number }[]} results
 * @param {{ envName: string, url: string, error: string }[]} failures
 * @returns {string}
 */
export function formatHealthCheckAllSummary(results, failures) {
  const lines = ['Health check summary:'];
  for (const r of results) {
    lines.push(
      `  ✓ ${r.envName.padEnd(14)} → HTTP ${r.status} (${r.elapsed}ms) ${r.url}`
    );
  }
  for (const f of failures) {
    lines.push(`  ✗ ${f.envName.padEnd(14)} → FAILED: ${f.error}`);
  }
  lines.push('');
  if (failures.length === 0) {
    lines.push(`All ${results.length} environment(s) passed health checks.`);
  } else {
    const total = results.length + failures.length;
    lines.push(
      `${failures.length} of ${total} environment(s) failed health checks. See above for details.`
    );
  }
  return lines.join('\n');
}

export default {
  resolveEnvHealthCheckUrl,
  anyEnvHasResolvableHealthCheckUrl,
  isHealthyHttpStatus,
  checkEnvHealth,
  runHealthChecksForEnvs,
  formatHealthCheckAllSummary,
};
