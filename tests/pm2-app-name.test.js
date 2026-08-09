import {
  resolvePm2AppName,
  isGrandfatheredPm2Env,
  sanitizePm2AppName,
} from '../src/utils/pm2-app-name.js';

describe('PM2 app name scoping (multi-env same host)', () => {
  const multiConfig = {
    project: 'myapi',
    projectType: 'backend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments: {
      development: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        // init default: appName === project (would collide without scoping)
        config: { host: '10.0.0.1', appName: 'myapi', port: 3000 },
      },
      staging: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: { host: '10.0.0.1', appName: 'myapi', port: 3001 },
      },
    },
  };

  test('grandfathered development keeps legacy project PM2 name (non-breaking)', () => {
    expect(isGrandfatheredPm2Env(multiConfig, 'development')).toBe(true);
    expect(resolvePm2AppName(multiConfig, 'development')).toBe('myapi');
  });

  test('non-grandfathered staging with same default appName auto-scopes to {project}-{env}', () => {
    expect(isGrandfatheredPm2Env(multiConfig, 'staging')).toBe(false);
    expect(resolvePm2AppName(multiConfig, 'staging')).toBe('myapi-staging');
  });

  test('two backend envs on same host get distinct PM2 names (no collision)', () => {
    const a = resolvePm2AppName(multiConfig, 'development');
    const b = resolvePm2AppName(multiConfig, 'staging');
    expect(a).not.toBe(b);
    expect(a).toBe('myapi');
    expect(b).toBe('myapi-staging');
  });

  test('single-env project keeps project PM2 name', () => {
    const single = {
      project: 'legacy-api',
      projectType: 'backend',
      defaultEnvironment: 'default',
      unprefixedSecretEnvironment: 'default',
      environments: {
        default: {
          enabled: true,
          method: 'ssh',
          trigger: 'push',
          config: { appName: 'legacy-api' },
        },
      },
    };
    expect(resolvePm2AppName(single, 'default')).toBe('legacy-api');
  });

  test('explicit distinct appName on non-grandfathered env is preserved', () => {
    const cfg = {
      ...multiConfig,
      environments: {
        ...multiConfig.environments,
        staging: {
          ...multiConfig.environments.staging,
          config: { host: '10.0.0.1', appName: 'staging-workers', port: 3001 },
        },
      },
    };
    expect(resolvePm2AppName(cfg, 'staging')).toBe('staging-workers');
    expect(resolvePm2AppName(cfg, 'development')).toBe('myapi');
  });

  test('SSH_APP_NAME overlay colliding with grandfathered name is auto-scoped', () => {
    expect(
      resolvePm2AppName(multiConfig, 'staging', { SSH_APP_NAME: 'myapi' })
    ).toBe('myapi-staging');
  });

  test('sanitizePm2AppName strips unsafe chars', () => {
    expect(sanitizePm2AppName('My App!')).toBe('My-App-');
  });
});
