import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  loadConfig,
  migrateConfigToEnvironments,
  needsConfigMigration,
  isNewEnvironmentShape,
} from '../src/core/config.js';

describe('config multi-env migration', () => {
  test('flat single-env config migrates to environments.default', () => {
    const raw = {
      project: 'demo',
      projectType: 'frontend',
      type: 'ssh',
      host: '1.2.3.4',
      user: 'ubuntu',
      deployPath: '/var/www/demo',
      storage: ['local'],
    };

    expect(needsConfigMigration(raw)).toBe(true);
    const { config, migrated, reason } = migrateConfigToEnvironments(raw);
    expect(migrated).toBe(true);
    expect(reason).toBe('flat');
    expect(config.defaultEnvironment).toBe('default');
    expect(config.deploy).toBeUndefined();
    expect(config.type).toBeUndefined();
    expect(config.host).toBeUndefined();
    expect(isNewEnvironmentShape(config.environments.default)).toBe(true);
    expect(config.environments.default).toEqual({
      enabled: true,
      method: 'ssh',
      trigger: 'manual',
      config: {
        host: '1.2.3.4',
        user: 'ubuntu',
        deployPath: '/var/www/demo',
      },
    });
    expect(config.unprefixedSecretEnvironment).toBe('default');
  });

  test('legacy environments+deploy[] migrates to enabled/method/trigger/config', () => {
    const raw = {
      project: 'demo',
      deploy: ['production'],
      environments: {
        production: {
          type: 'ssh',
          host: '10.0.0.1',
          user: 'deploy',
          path: '/var/www/app',
        },
        staging: {
          type: 'docker',
          dockerImageName: 'demo',
        },
      },
      storage: ['local'],
    };

    const { config, migrated } = migrateConfigToEnvironments(raw);
    expect(migrated).toBe(true);
    expect(config.defaultEnvironment).toBe('production');
    expect(config.deploy).toBeUndefined();
    expect(config.environments.production).toEqual({
      enabled: true,
      method: 'ssh',
      trigger: 'manual',
      config: {
        host: '10.0.0.1',
        user: 'deploy',
        path: '/var/www/app',
      },
    });
    expect(config.environments.staging).toEqual({
      enabled: false,
      method: 'docker',
      trigger: 'manual',
      config: {
        dockerImageName: 'demo',
      },
    });
  });

  test('migration is idempotent — running twice does not double-wrap', () => {
    const raw = {
      project: 'demo',
      type: 'kubernetes',
      kubeNamespace: 'demo',
      dockerImageName: 'demo',
    };

    const first = migrateConfigToEnvironments(raw);
    expect(first.migrated).toBe(true);
    const second = migrateConfigToEnvironments(first.config);
    expect(second.migrated).toBe(false);
    expect(second.config).toEqual(first.config);
    expect(second.config.environments.default.config.config).toBeUndefined();
    expect(second.config.environments.default.method).toBe('kubernetes');
  });

  test('loadConfig rewrites file once and is idempotent on second load', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-migrate-'));
    try {
      const configPath = path.join(tmp, 'deployhub.config.json');
      await fs.writeJson(configPath, {
        project: 'demo',
        projectType: 'frontend',
        deploy: ['production'],
        environments: {
          production: { type: 'ssh', host: '127.0.0.1', user: 'u', deployPath: '/app' },
        },
        storage: ['local'],
      });

      const loaded = await loadConfig(tmp);
      expect(loaded.defaultEnvironment).toBe('production');
      expect(loaded.environments.production.method).toBe('ssh');
      expect(loaded.environments.production.config.host).toBe('127.0.0.1');
      expect(loaded.deploy).toEqual(['production']);

      const onDisk = await fs.readJson(configPath);
      expect(onDisk.deploy).toBeUndefined();
      expect(onDisk.environments.production.method).toBe('ssh');
      expect(needsConfigMigration(onDisk)).toBe(false);

      const loadedAgain = await loadConfig(tmp);
      expect(loadedAgain.environments.production.config.host).toBe('127.0.0.1');
      expect(loadedAgain.defaultEnvironment).toBe('production');
    } finally {
      await fs.remove(tmp);
    }
  });

  test('loadConfig rejects defaultEnvironment that does not exist in environments', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-bad-default-'));
    try {
      await fs.writeJson(path.join(tmp, 'deployhub.config.json'), {
        project: 'demo',
        defaultEnvironment: 'missing-env',
        environments: {
          production: { enabled: true, method: 'ssh', trigger: 'manual', config: {} },
        },
        storage: ['local'],
      });
      await expect(loadConfig(tmp)).rejects.toThrow(/defaultEnvironment "missing-env"/);
    } finally {
      await fs.remove(tmp);
    }
  });

  test('loadConfig silent migration sets unprefixedSecretEnvironment with environments.default', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-migrate-flat-'));
    try {
      const configPath = path.join(tmp, 'deployhub.config.json');
      await fs.writeJson(configPath, {
        project: 'demo',
        projectType: 'frontend',
        type: 'ssh',
        host: '1.2.3.4',
        user: 'ubuntu',
        deployPath: '/var/www/demo',
        storage: ['local'],
      });

      const loaded = await loadConfig(tmp);
      expect(loaded.defaultEnvironment).toBe('default');
      expect(loaded.unprefixedSecretEnvironment).toBe('default');
      expect(loaded.environments.default.method).toBe('ssh');

      const onDisk = await fs.readJson(configPath);
      expect(onDisk.unprefixedSecretEnvironment).toBe('default');
      expect(onDisk.environments.default).toBeTruthy();
    } finally {
      await fs.remove(tmp);
    }
  });

  test('trigger defaults to manual and is never inferred as push', () => {
    const { config } = migrateConfigToEnvironments({
      project: 'demo',
      environments: { production: { type: 'ssh', host: 'x' } },
      deploy: ['production'],
    });
    expect(config.environments.production.trigger).toBe('manual');
  });
});
