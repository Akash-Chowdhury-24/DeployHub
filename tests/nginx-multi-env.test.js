import {
  sanitizeNginxSiteName,
  isGrandfatheredNginxEnv,
  resolveNginxSiteName,
  getNginxSitesAvailablePath,
  getNginxSitesEnabledPath,
  getNginxConfDPath,
} from '../src/utils/nginx.js';

describe('nginx site name scoping (multi-env same host)', () => {
  const multiConfig = {
    project: 'myapp',
    defaultEnvironment: 'production',
    unprefixedSecretEnvironment: 'production',
    environments: {
      staging: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
    },
  };

  test('grandfathered production keeps legacy {project} site filename', () => {
    expect(isGrandfatheredNginxEnv(multiConfig, 'production')).toBe(true);
    expect(resolveNginxSiteName(multiConfig, 'production')).toBe('myapp');
    expect(getNginxSitesAvailablePath('myapp')).toBe('/etc/nginx/sites-available/myapp');
    expect(getNginxConfDPath('myapp')).toBe('/etc/nginx/conf.d/myapp.conf');
  });

  test('non-grandfathered staging uses {project}-{env} on debian and rhel paths', () => {
    expect(isGrandfatheredNginxEnv(multiConfig, 'staging')).toBe(false);
    expect(resolveNginxSiteName(multiConfig, 'staging')).toBe('myapp-staging');
    expect(getNginxSitesAvailablePath('myapp-staging')).toBe(
      '/etc/nginx/sites-available/myapp-staging'
    );
    expect(getNginxSitesEnabledPath('myapp-staging')).toBe(
      '/etc/nginx/sites-enabled/myapp-staging'
    );
    expect(getNginxConfDPath('myapp-staging')).toBe('/etc/nginx/conf.d/myapp-staging.conf');
  });

  test('two env site names are distinct for same project', () => {
    const prodSite = resolveNginxSiteName(multiConfig, 'production');
    const stagingSite = resolveNginxSiteName(multiConfig, 'staging');
    expect(prodSite).not.toBe(stagingSite);
    expect(prodSite).toBe('myapp');
    expect(stagingSite).toBe('myapp-staging');
  });

  test('single-env project keeps {project} filename (no breaking change)', () => {
    const single = {
      project: 'legacy-app',
      defaultEnvironment: 'default',
      environments: {
        default: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };
    expect(resolveNginxSiteName(single, 'default')).toBe('legacy-app');
    expect(sanitizeNginxSiteName('legacy-app', 'default', true)).toBe('legacy-app');
  });

  test('nginx site filename does not change for the original env when a second env is added', () => {
    // User named their only env "production" from day one (not "default").
    const config = {
      project: 'myapp',
      defaultEnvironment: 'production',
      unprefixedSecretEnvironment: 'production',
      environments: {
        production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
      },
    };

    expect(Object.keys(config.environments)).toHaveLength(1);
    expect(isGrandfatheredNginxEnv(config, 'production')).toBe(true);
    const before = resolveNginxSiteName(config, 'production');
    expect(before).toBe('myapp'); // unsuffixed — live sites-available/myapp

    // Simulate `deployhub env add staging`: add staging, leave grandfather markers unchanged.
    config.environments.staging = {
      enabled: true,
      method: 'ssh',
      trigger: 'manual',
      config: {},
    };

    expect(Object.keys(config.environments)).toHaveLength(2);
    expect(resolveNginxSiteName(config, 'production')).toBe(before);
    expect(resolveNginxSiteName(config, 'production')).toBe('myapp');
    expect(isGrandfatheredNginxEnv(config, 'production')).toBe(true);
    expect(resolveNginxSiteName(config, 'staging')).toBe('myapp-staging');
    expect(isGrandfatheredNginxEnv(config, 'staging')).toBe(false);
  });
});
