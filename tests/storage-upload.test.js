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
    expect(history[0].buildId).toBe('0.0.0-abc111');
    expect(history[0].remoteKey).toBe('demo-app/builds/0.0.0-abc111/artifact.zip');
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
    expect(history.map((h) => h.buildId)).toEqual(['0.0.0-second', '0.0.0-first']);
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
