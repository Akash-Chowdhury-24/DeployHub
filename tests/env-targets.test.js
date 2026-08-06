import {
  resolveEnvTargets,
  getEnabledEnvironmentNames,
  isEnvEnabled,
} from '../src/core/environments.js';

describe('resolveEnvTargets', () => {
  const config = {
    defaultEnvironment: 'production',
    environments: {
      production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      testing: { enabled: true, method: 'docker', trigger: 'manual', config: {} },
      staging: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
    },
  };

  test('no --env deploys defaultEnvironment only', () => {
    expect(resolveEnvTargets(config)).toEqual({
      targets: ['production'],
      skippedDisabled: [],
    });
  });

  test('--env name selects one enabled env', () => {
    expect(resolveEnvTargets(config, 'testing')).toEqual({
      targets: ['testing'],
      skippedDisabled: [],
    });
  });

  test('--env disabled name fails loudly', () => {
    expect(() => resolveEnvTargets(config, 'staging')).toThrow(
      /Environment "staging" is disabled\. Enable it with: deployhub env enable staging/
    );
  });

  test('--env all deploys enabled and skips disabled without error', () => {
    expect(resolveEnvTargets(config, 'all')).toEqual({
      targets: ['production', 'testing'],
      skippedDisabled: ['staging'],
    });
  });

  test('--env unknown name fails', () => {
    expect(() => resolveEnvTargets(config, 'nope')).toThrow(/not found/);
  });

  test('getEnabledEnvironmentNames ignores disabled', () => {
    expect(getEnabledEnvironmentNames(config).sort()).toEqual(['production', 'testing']);
    expect(isEnvEnabled(config.environments.staging)).toBe(false);
  });

  test('B2: --env all with every env disabled yields empty targets', () => {
    expect(
      resolveEnvTargets(
        {
          defaultEnvironment: 'a',
          environments: {
            a: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
            b: { enabled: false, method: 'ssh', trigger: 'manual', config: {} },
          },
        },
        'all'
      )
    ).toEqual({ targets: [], skippedDisabled: ['a', 'b'] });
  });
});
