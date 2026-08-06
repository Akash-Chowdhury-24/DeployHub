/**
 * Exercises REAL doctor.js exports — not a mirrored reimplementation.
 * (Earlier versions of this file only mirrored exit logic while doctor.js
 * had a syntax error that prevented the module from loading at all.)
 */
import {
  doctorHasBlockingFailures,
  collectEnvDeploymentChecks,
  runDeploymentChecks,
} from '../src/commands/doctor.js';

describe('G — doctor per-env blocking vs informational (real module)', () => {
  test('doctor.js loads and exports runDeploymentChecks', () => {
    expect(typeof runDeploymentChecks).toBe('function');
    expect(typeof doctorHasBlockingFailures).toBe('function');
    expect(typeof collectEnvDeploymentChecks).toBe('function');
  });

  test('disabled env failure is informational; enabled env failures block exit', () => {
    const informational = new Set(['staging/SSH connection']);
    const results = [
      { name: 'production/SSH connection', pass: false, message: 'timeout' },
      { name: 'staging/SSH connection', pass: false, message: 'disabled env check' },
      { name: 'production/Docker registry', pass: false, message: 'missing creds' },
    ];

    expect(doctorHasBlockingFailures(results, informational)).toBe(true);

    const onlyDisabledFailed = [
      { name: 'production/SSH connection', pass: true, message: 'ok' },
      { name: 'staging/SSH connection', pass: false, message: 'disabled' },
    ];
    expect(doctorHasBlockingFailures(onlyDisabledFailed, informational)).toBe(false);
  });

  test('exception in one env check does not prevent other env results from being collected', async () => {
    const config = {
      project: 'demo',
      environments: {
        production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
        staging: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
        'disabled-k8s': {
          enabled: false,
          method: 'kubernetes',
          trigger: 'manual',
          config: {},
        },
      },
    };

    const { results, informationalCheckNames } = await collectEnvDeploymentChecks(
      config,
      ['production', 'staging', 'disabled-k8s'],
      {
        includeDisabled: true,
        runChecks: async (_config, envName) => {
          if (envName === 'staging') {
            throw new Error('simulated provider crash');
          }
          return [
            {
              name: 'checks',
              pass: envName === 'production',
              message: envName === 'production' ? 'ok' : 'fail',
            },
          ];
        },
      }
    );

    expect(results).toHaveLength(3);
    expect(results.find((r) => r.name === 'production/checks')?.pass).toBe(true);
    expect(results.find((r) => r.name === 'staging/checks')?.message).toMatch(
      /simulated provider crash/
    );
    expect(results.find((r) => r.name === 'disabled-k8s/checks')?.pass).toBe(false);
    expect(informationalCheckNames.has('disabled-k8s/checks')).toBe(true);
    expect(informationalCheckNames.has('staging/checks')).toBe(false);

    // staging (enabled) failure is blocking; disabled-k8s is not
    expect(doctorHasBlockingFailures(results, informationalCheckNames)).toBe(true);

    const withoutStaging = results.filter((r) => r.name !== 'staging/checks');
    // production fail=false (pass true), disabled-k8s informational fail → no blocking
    expect(doctorHasBlockingFailures(withoutStaging, informationalCheckNames)).toBe(false);
  });
});
