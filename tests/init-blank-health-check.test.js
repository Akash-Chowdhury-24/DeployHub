import { normalizeInitHealthCheckUrl } from '../src/deployment/init-helpers.js';
import {
  resolveEnvHealthCheckUrl,
  anyEnvHasResolvableHealthCheckUrl,
  runHealthChecksForEnvs,
} from '../src/utils/health-check.js';
import { buildPipelineStages } from '../src/core/stages.js';

describe('blank health check at init — no localhost synthesis', () => {
  test('normalizeInitHealthCheckUrl: blank / whitespace → empty (never localhost)', () => {
    expect(normalizeInitHealthCheckUrl('')).toBe('');
    expect(normalizeInitHealthCheckUrl('   ')).toBe('');
    expect(normalizeInitHealthCheckUrl(undefined)).toBe('');
    expect(normalizeInitHealthCheckUrl(null)).toBe('');
    expect(normalizeInitHealthCheckUrl('https://api.example.com/health')).toBe(
      'https://api.example.com/health'
    );
    // Must not invent a default from a port — callers pass only the prompt answer.
    expect(normalizeInitHealthCheckUrl('')).not.toMatch(/localhost/);
  });

  test('init-shaped config with blank health answer: empty url, verify off, no localhost', () => {
    const healthUrl = normalizeInitHealthCheckUrl(''); // user hit enter
    const port = 3000;
    // Reproduce former buggy synthesis so the test documents it must NOT happen:
    const buggyWouldHaveBeen = `http://localhost:${port}/health`;
    expect(healthUrl).toBe('');
    expect(healthUrl).not.toBe(buggyWouldHaveBeen);

    const config = {
      project: 'demo',
      projectType: 'backend',
      port,
      defaultEnvironment: 'default',
      environments: {
        default: {
          enabled: true,
          method: 'ec2',
          trigger: 'push',
          config: { host: 'ec2.example.com' },
        },
      },
      healthCheck: { url: healthUrl, timeout: 30 },
      pipeline: {
        test: true,
        deploy: true,
        verify: !!healthUrl,
        notify: false,
      },
    };

    expect(config.healthCheck.url).toBe('');
    expect(config.pipeline.verify).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/localhost/);
    expect(
      anyEnvHasResolvableHealthCheckUrl(config, ['default'])
    ).toBe(false);
  });

  test('verify stage enabled gate is false when no health URL — no HTTP attempted', async () => {
    const config = {
      project: 'demo',
      projectType: 'backend',
      port: 3000,
      pipeline: { verify: false, deploy: true, test: false, notify: false },
      healthCheck: { url: '', timeout: 30 },
      environments: {
        default: {
          enabled: true,
          method: 'ec2',
          trigger: 'push',
          config: {},
        },
      },
    };

    /** @type {Record<string, unknown>} */
    const state = { deployedTargets: ['default'] };
    const stages = buildPipelineStages(config, process.cwd(), state);
    const verify = stages.find((s) => s.name === 'verify');
    expect(verify).toBeTruthy();
    expect(verify.enabled({ config, cwd: process.cwd(), state })).toBe(false);

    let httpCalls = 0;
    await runHealthChecksForEnvs(config, ['default'], {
      httpGet: async () => {
        httpCalls += 1;
        return { status: 200 };
      },
    });
    // runHealthChecksForEnvs skips envs with no URL (no request)
    expect(httpCalls).toBe(0);
    expect(resolveEnvHealthCheckUrl(config, 'default')).toBe('');
  });

  test('verify stage still enables when a real health URL is configured', () => {
    const config = {
      project: 'demo',
      pipeline: { verify: true, deploy: true },
      healthCheck: { url: 'https://api.example.com/health', timeout: 30 },
      environments: {
        default: {
          enabled: true,
          method: 'ec2',
          trigger: 'push',
          config: {},
        },
      },
    };
    /** @type {Record<string, unknown>} */
    const state = { deployedTargets: ['default'] };
    const verify = buildPipelineStages(config, process.cwd(), state).find(
      (s) => s.name === 'verify'
    );
    expect(verify.enabled({ config, cwd: process.cwd(), state })).toBe(true);
    expect(resolveEnvHealthCheckUrl(config, 'default')).toBe(
      'https://api.example.com/health'
    );
  });
});
