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

const { uploadToAll, loadArtifactHistory } = await import('../src/storage/index.js');

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

describe('storage uploadToAll build keys + history', () => {
  /** @type {string} */
  let tmpZip;
  /** @type {ReturnType<typeof createMemoryProvider>} */
  let mem;

  beforeEach(async () => {
    mockProviders.clear();
    mem = createMemoryProvider();
    mockProviders.set('local', mem);
    tmpZip = path.join(os.tmpdir(), `deployhub-zip-${Date.now()}.zip`);
    await fs.writeFile(tmpZip, 'fake-zip-bytes');
  });

  afterEach(async () => {
    await fs.remove(tmpZip).catch(() => {});
  });

  test('uploads unique build key, latest pointer, and history — never legacy v{semver} key', async () => {
    const config = {
      project: 'demo-app',
      version: '0.0.0',
      buildId: '0.0.0-abc111',
    };

    await uploadToAll(['local'], tmpZip, config);

    expect(mem.store.has('demo-app/builds/0.0.0-abc111/artifact.zip')).toBe(true);
    expect(mem.store.has('demo-app/latest/artifact.zip')).toBe(true);
    expect(mem.store.has('demo-app/history.json')).toBe(true);
    expect(mem.store.has('demo-app/v0.0.0/artifact.zip')).toBe(false);

    const history = await loadArtifactHistory(['local'], 'demo-app');
    expect(history.entries[0].buildId).toBe('0.0.0-abc111');
    expect(history.entries[0].remoteKey).toBe('demo-app/builds/0.0.0-abc111/artifact.zip');
    expect(history.source).toBe('local');
  });

  test('second upload with same semver does not overwrite first build key', async () => {
    await uploadToAll(['local'], tmpZip, {
      project: 'demo-app',
      version: '0.0.0',
      buildId: '0.0.0-first',
    });
    await uploadToAll(['local'], tmpZip, {
      project: 'demo-app',
      version: '0.0.0',
      buildId: '0.0.0-second',
    });

    expect(mem.store.has('demo-app/builds/0.0.0-first/artifact.zip')).toBe(true);
    expect(mem.store.has('demo-app/builds/0.0.0-second/artifact.zip')).toBe(true);

    const history = await loadArtifactHistory(['local'], 'demo-app');
    expect(history.entries.map((h) => h.buildId)).toEqual(['0.0.0-second', '0.0.0-first']);
    expect(history.source).toBe('local');
  });

  test('latest pointer is overwritten on each upload', async () => {
    const zip2 = path.join(os.tmpdir(), `deployhub-zip2-${Date.now()}.zip`);
    await fs.writeFile(zip2, 'second-bytes');
    try {
      await uploadToAll(['local'], tmpZip, {
        project: 'demo-app',
        version: '1.0.0',
        buildId: '1.0.0-a',
      });
      await uploadToAll(['local'], zip2, {
        project: 'demo-app',
        version: '1.0.0',
        buildId: '1.0.0-b',
      });
      const latest = mem.store.get('demo-app/latest/artifact.zip');
      expect(Buffer.isBuffer(latest) ? latest.toString() : latest).toBe('second-bytes');
    } finally {
      await fs.remove(zip2).catch(() => {});
    }
  });
});

describe('loadArtifactHistory empty vs error', () => {
  beforeEach(() => {
    mockProviders.clear();
  });

  test('returns empty array when history.json is genuinely missing', async () => {
    const mem = createMemoryProvider();
    mockProviders.set('aws', mem);

    const history = await loadArtifactHistory(['aws'], 'demo-app');
    expect(history).toEqual({ entries: [], source: null });
  });

  test('throws a clear credential-style error when verify fails with Access Denied', async () => {
    mockProviders.set('aws', {
      async upload() {},
      async download() {},
      async verify() {
        const err = new Error('Access Denied');
        err.name = 'AccessDenied';
        throw err;
      },
      async delete() {},
      async testConnection() {},
    });

    await expect(loadArtifactHistory(['aws'], 'demo-app')).rejects.toThrow(
      /Could not check remote history via aws:.*Access Denied.*credentials/
    );
  });

  test('throws when provider factory / credentials are incomplete', async () => {
    // No mock registered for azure → createAzureProvider from mock returns undefined
    // Use a provider that throws on construction via verify path: getStorageProvider returns
    // a broken provider. Simulate factory-level failure by making createAwsProvider throw.
    mockProviders.set('aws', null);

    await expect(loadArtifactHistory(['aws'], 'demo-app')).rejects.toThrow(
      /Could not check remote history via aws/
    );
  });

  test('throws on download failure after verify succeeds', async () => {
    mockProviders.set('azure', {
      async upload() {},
      async download() {
        throw new Error('NetworkingError: socket hang up');
      },
      async verify() {
        return true;
      },
      async delete() {},
      async testConnection() {},
    });

    await expect(loadArtifactHistory(['azure'], 'proj')).rejects.toThrow(
      /Could not check remote history via azure:.*socket hang up/
    );
  });

  test('skips missing on first provider and reads history from second', async () => {
    const empty = createMemoryProvider();
    const filled = createMemoryProvider();
    filled.store.set(
      'demo/history.json',
      JSON.stringify([
        {
          buildId: '1.0.0-x',
          semver: '1.0.0',
          uploadedAt: '2026-01-01T00:00:00.000Z',
          remoteKey: 'demo/builds/1.0.0-x/artifact.zip',
        },
      ])
    );
    mockProviders.set('aws', empty);
    mockProviders.set('azure', filled);

    const history = await loadArtifactHistory(['aws', 'azure'], 'demo');
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].buildId).toBe('1.0.0-x');
    expect(history.source).toBe('azure');
  });
});
