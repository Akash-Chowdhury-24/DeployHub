import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const mockProviders = new Map();

jest.unstable_mockModule('../src/storage/providers/aws.js', () => ({
  createAwsProvider: () => mockProviders.get('aws'),
}));
jest.unstable_mockModule('../src/storage/providers/local.js', () => ({
  createLocalProvider: () => mockProviders.get('local'),
}));
jest.unstable_mockModule('../src/storage/providers/azure.js', () => ({
  createAzureProvider: () => mockProviders.get('azure'),
}));
jest.unstable_mockModule('../src/storage/providers/gcp.js', () => ({
  createGcpProvider: () => mockProviders.get('gcp'),
}));
jest.unstable_mockModule('../src/storage/providers/gdrive.js', () => ({
  createGdriveProvider: () => mockProviders.get('gdrive'),
}));
jest.unstable_mockModule('../src/storage/providers/dropbox.js', () => ({
  createDropboxProvider: () => mockProviders.get('dropbox'),
}));
jest.unstable_mockModule('../src/storage/providers/ftp.js', () => ({
  createFtpProvider: () => mockProviders.get('ftp'),
}));

const {
  uploadToAll,
  recordEnvDeployment,
  loadEnvArtifactHistory,
  loadArtifactHistory,
  ensureLegacyHistoryCopiedToDefaultEnv,
} = await import('../src/storage/index.js');
const { resolveRollbackTarget } = await import('../src/utils/artifact-history.js');
const {
  envHistoryRemoteKey,
  envLatestArtifactRemoteKey,
  buildArtifactRemoteKey,
} = await import('../src/utils/build-id.js');

function createMemoryProvider() {
  /** @type {Map<string, Buffer|string>} */
  const store = new Map();
  return {
    store,
    async upload(localPath, remoteKey) {
      store.set(remoteKey, await fs.readFile(localPath));
    },
    async download(remoteKey, localPath) {
      const data = store.get(remoteKey);
      if (!data) throw new Error(`missing ${remoteKey}`);
      await fs.ensureDir(path.dirname(localPath));
      await fs.writeFile(localPath, data);
    },
    async verify(remoteKey) {
      return store.has(remoteKey);
    },
    async delete(remoteKey) {
      store.delete(remoteKey);
    },
    async testConnection() {},
  };
}

describe('per-environment storage / history isolation', () => {
  /** @type {string} */
  let tmpZip;
  /** @type {ReturnType<typeof createMemoryProvider>} */
  let mem;

  beforeEach(async () => {
    mockProviders.clear();
    mem = createMemoryProvider();
    mockProviders.set('local', mem);
    tmpZip = path.join(os.tmpdir(), `deployhub-env-zip-${Date.now()}.zip`);
    await fs.writeFile(tmpZip, 'fake-zip-bytes');
  });

  afterEach(async () => {
    await fs.remove(tmpZip).catch(() => {});
  });

  test('shared builds key unchanged; env history and latest are per-env', async () => {
    const config = {
      project: 'demo-app',
      version: '1.0.0',
      buildId: '1.0.0-aaa',
      defaultEnvironment: 'testing',
    };

    await uploadToAll(['local'], tmpZip, config);
    expect(mem.store.has(buildArtifactRemoteKey('demo-app', '1.0.0-aaa'))).toBe(true);

    await recordEnvDeployment(['local'], tmpZip, config, 'testing', {
      buildId: '1.0.0-aaa',
      semver: '1.0.0',
    });
    await recordEnvDeployment(['local'], tmpZip, { ...config, buildId: '1.0.0-bbb' }, 'production', {
      buildId: '1.0.0-bbb',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-bbb'),
    });

    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'testing'))).toBe(true);
    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'production'))).toBe(true);
    expect(mem.store.has(envLatestArtifactRemoteKey('demo-app', 'testing'))).toBe(true);
    expect(mem.store.has(envLatestArtifactRemoteKey('demo-app', 'production'))).toBe(true);

    const testing = await loadEnvArtifactHistory(['local'], 'demo-app', 'testing');
    const production = await loadEnvArtifactHistory(['local'], 'demo-app', 'production');

    expect(testing.entries.map((e) => e.buildId)).toEqual(['1.0.0-aaa']);
    expect(production.entries.map((e) => e.buildId)).toEqual(['1.0.0-bbb']);

    // Deploy another build to testing — must not change production history
    await recordEnvDeployment(['local'], tmpZip, { ...config, buildId: '1.0.0-ccc' }, 'testing', {
      buildId: '1.0.0-ccc',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-ccc'),
    });

    const testing2 = await loadEnvArtifactHistory(['local'], 'demo-app', 'testing');
    const production2 = await loadEnvArtifactHistory(['local'], 'demo-app', 'production');
    expect(testing2.entries.map((e) => e.buildId)).toEqual(['1.0.0-ccc', '1.0.0-aaa']);
    expect(production2.entries.map((e) => e.buildId)).toEqual(['1.0.0-bbb']);

    const prodRollback = resolveRollbackTarget(production2.entries);
    expect(prodRollback.ok).toBe(false); // only one entry — no previous
    expect(prodRollback.reason).toBe('no-previous');

    // Give production a previous entry, then ensure rollback stays in production
    await recordEnvDeployment(['local'], tmpZip, config, 'production', {
      buildId: '1.0.0-old',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-old'),
    });
    await recordEnvDeployment(['local'], tmpZip, config, 'production', {
      buildId: '1.0.0-bbb',
      semver: '1.0.0',
      remoteKey: buildArtifactRemoteKey('demo-app', '1.0.0-bbb'),
    });

    const prodHist = await loadEnvArtifactHistory(['local'], 'demo-app', 'production');
    const resolved = resolveRollbackTarget(prodHist.entries);
    expect(resolved.ok).toBe(true);
    expect(resolved.entry.buildId).toBe('1.0.0-old');

    const testHist = await loadEnvArtifactHistory(['local'], 'demo-app', 'testing');
    expect(testHist.entries.map((e) => e.buildId)).not.toContain('1.0.0-old');
  });

  test('legacy project history.json is copied once into default env history', async () => {
    mem.store.set(
      'demo-app/history.json',
      JSON.stringify([
        {
          buildId: '0.9.0-legacy',
          semver: '0.9.0',
          uploadedAt: '2026-01-01T00:00:00.000Z',
          remoteKey: 'demo-app/builds/0.9.0-legacy/artifact.zip',
        },
      ])
    );

    const copied = await ensureLegacyHistoryCopiedToDefaultEnv(
      ['local'],
      'demo-app',
      'default'
    );
    expect(copied).toBe(true);

    const loaded = await loadEnvArtifactHistory(['local'], 'demo-app', 'default', {
      defaultEnvironment: 'default',
      allowLegacyFallback: false,
    });
    expect(loaded.entries[0].buildId).toBe('0.9.0-legacy');
    expect(loaded.legacyFallback).toBeUndefined();
    expect(mem.store.has(envHistoryRemoteKey('demo-app', 'default'))).toBe(true);

    const again = await ensureLegacyHistoryCopiedToDefaultEnv(
      ['local'],
      'demo-app',
      'default'
    );
    expect(again).toBe(false);

    // Non-default env must NOT inherit project history
    const staging = await loadEnvArtifactHistory(['local'], 'demo-app', 'staging', {
      defaultEnvironment: 'default',
    });
    expect(staging.entries).toEqual([]);
  });

  test('project build catalog history still written on upload', async () => {
    await uploadToAll(['local'], tmpZip, {
      project: 'demo-app',
      version: '2.0.0',
      buildId: '2.0.0-x',
    });
    const catalog = await loadArtifactHistory(['local'], 'demo-app');
    expect(catalog.entries[0].buildId).toBe('2.0.0-x');
  });

  test('concurrent loadEnvArtifactHistory calls do not cross-contaminate via shared tmp paths', async () => {
    const config = {
      project: 'demo-app',
      version: '1.0.0',
      storage: ['local'],
    };

    for (const env of ['alpha', 'beta', 'gamma']) {
      await recordEnvDeployment(['local'], tmpZip, config, env, {
        buildId: `${env}-build`,
        semver: '1.0.0',
        remoteKey: buildArtifactRemoteKey('demo-app', `${env}-build`),
      });
    }

    // Hammer parallel loads — previously Date.now()-based tmp paths collided
    // across concurrent callers and could return empty/wrong history.
    const rounds = Array.from({ length: 40 }, () =>
      Promise.all(
        ['alpha', 'beta', 'gamma'].map(async (env) => {
          const { entries } = await loadEnvArtifactHistory(['local'], 'demo-app', env, {
            allowLegacyFallback: false,
          });
          return { env, ids: entries.map((e) => e.buildId) };
        })
      )
    );

    const all = await Promise.all(rounds);
    for (const batch of all) {
      for (const { env, ids } of batch) {
        expect(ids).toEqual([`${env}-build`]);
      }
    }
  });
});
