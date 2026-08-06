import {
  resolveEnvHealthCheckUrl,
  anyEnvHasResolvableHealthCheckUrl,
  runHealthChecksForEnvs,
  formatHealthCheckAllSummary,
} from '../src/utils/health-check.js';

describe('per-environment health check URLs', () => {
  const config = {
    healthCheck: { url: 'https://fallback.example.com', timeout: 5 },
    environments: {
      dev: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { healthCheckUrl: 'https://dev.example.com' },
      },
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
    },
  };

  test('each environment resolves its own healthCheckUrl override', () => {
    expect(resolveEnvHealthCheckUrl(config, 'dev')).toBe('https://dev.example.com');
    expect(resolveEnvHealthCheckUrl(config, 'staging')).toBe('https://staging.example.com');
    expect(resolveEnvHealthCheckUrl(config, 'production')).toBe('https://prod.example.com');
  });

  test('environment without override falls back to top-level healthCheck.url', () => {
    const mixed = {
      healthCheck: { url: 'https://global.example.com' },
      environments: {
        a: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };
    expect(resolveEnvHealthCheckUrl(mixed, 'a')).toBe('https://global.example.com');
  });

  test('no per-env override and no top-level url — verify stage skipped', () => {
    const bare = {
      healthCheck: { url: '' },
      environments: {
        a: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };
    expect(resolveEnvHealthCheckUrl(bare, 'a')).toBe('');
    expect(anyEnvHasResolvableHealthCheckUrl(bare, ['a'])).toBe(false);
  });

  test('deploy --env all: one unhealthy URL fails only that env in summary', async () => {
    /** @type {Record<string, number>} */
    const statuses = {
      'https://dev.example.com': 200,
      'https://staging.example.com': 503,
      'https://prod.example.com': 200,
    };

    const { results, failures } = await runHealthChecksForEnvs(
      config,
      ['dev', 'staging', 'production'],
      {
        httpGet: async (url) => ({ status: statuses[url] ?? 500 }),
      }
    );

    expect(results.map((r) => r.envName).sort()).toEqual(['dev', 'production']);
    expect(failures).toHaveLength(1);
    expect(failures[0].envName).toBe('staging');
    expect(failures[0].error).toMatch(/staging/);
    expect(failures[0].error).toMatch(/503/);

    const summary = formatHealthCheckAllSummary(results, failures);
    expect(summary).toContain('✓ dev');
    expect(summary).toContain('✓ production');
    expect(summary).toContain('✗ staging');
    expect(summary).toContain('1 of 3 environment(s) failed');
  });
});
