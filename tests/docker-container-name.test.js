import {
  resolveDockerContainerName,
  isGrandfatheredDockerContainerEnv,
  sanitizeDockerContainerName,
} from '../src/utils/docker-container-name.js';

describe('Docker container name scoping (multi-env same daemon)', () => {
  const multiConfig = {
    project: 'myapp',
    projectType: 'backend',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    environments: {
      development: {
        enabled: true,
        method: 'docker',
        trigger: 'push',
        config: { dockerImageName: 'myapp' },
      },
      staging: {
        enabled: true,
        method: 'docker',
        trigger: 'manual',
        config: { dockerImageName: 'myapp' },
      },
    },
  };

  test('grandfathered development keeps legacy project container name', () => {
    expect(isGrandfatheredDockerContainerEnv(multiConfig, 'development')).toBe(true);
    expect(resolveDockerContainerName(multiConfig, 'development')).toBe('myapp');
  });

  test('non-grandfathered staging auto-scopes to {project}-{env}', () => {
    expect(isGrandfatheredDockerContainerEnv(multiConfig, 'staging')).toBe(false);
    expect(resolveDockerContainerName(multiConfig, 'staging')).toBe('myapp-staging');
  });

  test('two docker envs on same daemon get distinct container names (no collision)', () => {
    const a = resolveDockerContainerName(multiConfig, 'development');
    const b = resolveDockerContainerName(multiConfig, 'staging');
    expect(a).not.toBe(b);
  });

  test('single-env project keeps project container name', () => {
    const single = {
      project: 'legacy',
      environments: {
        default: { enabled: true, method: 'docker', trigger: 'push', config: {} },
      },
    };
    expect(resolveDockerContainerName(single, 'default')).toBe('legacy');
  });

  test('sanitizeDockerContainerName strips unsafe chars', () => {
    expect(sanitizeDockerContainerName('My App!')).toBe('My-App-');
  });
});
