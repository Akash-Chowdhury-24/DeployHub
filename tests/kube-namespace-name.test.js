import {
  resolveKubeNamespace,
  isGrandfatheredKubeNamespaceEnv,
} from '../src/utils/kube-namespace-name.js';

describe('Kubernetes namespace scoping (multi-env same cluster)', () => {
  const multiConfig = {
    project: 'myapp',
    projectType: 'backend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments: {
      development: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'push',
        config: { kubeNamespace: 'myapp' },
      },
      staging: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'manual',
        // Same default as init — would collide without auto-scope
        config: { kubeNamespace: 'myapp' },
      },
    },
  };

  test('grandfathered development keeps configured/project namespace', () => {
    expect(isGrandfatheredKubeNamespaceEnv(multiConfig, 'development')).toBe(true);
    expect(resolveKubeNamespace(multiConfig, 'development')).toBe('myapp');
  });

  test('non-grandfathered staging with colliding namespace auto-scopes to {project}-{env}', () => {
    expect(isGrandfatheredKubeNamespaceEnv(multiConfig, 'staging')).toBe(false);
    expect(resolveKubeNamespace(multiConfig, 'staging')).toBe('myapp-staging');
  });

  test('two envs targeting same cluster get distinct namespaces', () => {
    expect(resolveKubeNamespace(multiConfig, 'development')).not.toBe(
      resolveKubeNamespace(multiConfig, 'staging')
    );
  });

  test('explicit distinct namespace on non-grandfathered env is preserved', () => {
    const cfg = {
      ...multiConfig,
      environments: {
        ...multiConfig.environments,
        staging: {
          ...multiConfig.environments.staging,
          config: { kubeNamespace: 'staging-ns' },
        },
      },
    };
    expect(resolveKubeNamespace(cfg, 'staging')).toBe('staging-ns');
    expect(resolveKubeNamespace(cfg, 'development')).toBe('myapp');
  });

  test('single-env keeps project namespace', () => {
    const single = {
      project: 'solo',
      environments: {
        default: {
          enabled: true,
          method: 'kubernetes',
          trigger: 'push',
          config: { kubeNamespace: 'solo' },
        },
      },
    };
    expect(resolveKubeNamespace(single, 'default')).toBe('solo');
  });
});
