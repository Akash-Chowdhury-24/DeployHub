import {
  runVerify,
} from '../src/commands/verify.js';
import { formatHealthCheckAllSummary } from '../src/utils/health-check.js';

describe('standalone deployhub verify — multi-env', () => {
  const config = {
    defaultEnvironment: 'staging',
    healthCheck: { url: 'https://fallback.example.com', timeout: 5 },
    environments: {
      staging: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { healthCheckUrl: 'https://staging.example.com' },
      },
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { healthCheckUrl: 'https://prod.example.com' },
      },
      disabled: {
        enabled: false,
        method: 'ssh',
        trigger: 'manual',
        config: { healthCheckUrl: 'https://disabled.example.com' },
      },
    },
  };

  /** @type {Record<string, number>} */
  const statuses = {
    'https://staging.example.com': 200,
    'https://prod.example.com': 200,
    'https://fallback.example.com': 200,
    'https://disabled.example.com': 200,
  };

  const httpGet = async (url) => ({ status: statuses[url] ?? 500 });

  test('verify --env <name> resolves that env healthCheckUrl override', async () => {
    const outcome = await runVerify(config, 'production', { httpGet });
    expect(outcome.ok).toBe(true);
    expect(outcome.targets).toEqual(['production']);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].envName).toBe('production');
    expect(outcome.results[0].url).toBe('https://prod.example.com');
    expect(outcome.message).toMatch(/production/);
    expect(outcome.message).toMatch(/200/);
  });

  test('verify with no --env falls back to defaultEnvironment', async () => {
    const outcome = await runVerify(config, undefined, { httpGet });
    expect(outcome.ok).toBe(true);
    expect(outcome.targets).toEqual(['staging']);
    expect(outcome.results[0].url).toBe('https://staging.example.com');
  });

  test('verify --env all uses same per-env summary format as deploy pipeline', async () => {
    statuses['https://prod.example.com'] = 503;

    const outcome = await runVerify(config, 'all', { httpGet });
    expect(outcome.ok).toBe(false);
    expect(outcome.targets.sort()).toEqual(['production', 'staging']);
    expect(outcome.skippedDisabled).toEqual(['disabled']);

    const expectedSummary = formatHealthCheckAllSummary(
      outcome.results,
      outcome.failures
    );
    expect(outcome.summary).toBe(expectedSummary);
    expect(outcome.summary).toContain('Health check summary:');
    expect(outcome.summary).toContain('✓ staging');
    expect(outcome.summary).toContain('✗ production');
    expect(outcome.summary).toMatch(/1 of 2 environment\(s\) failed/);

    statuses['https://prod.example.com'] = 200;
  });

  test('verify --env all all-pass still prints multi-env summary', async () => {
    const outcome = await runVerify(config, 'all', { httpGet });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('Health check summary:');
    expect(outcome.summary).toContain('All 2 environment(s) passed health checks.');
  });
});
