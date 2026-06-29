import fs from 'fs-extra';
import path from 'path';

/**
 * @param {Record<string, string>} [_env]
 */
export function createLocalProvider(_env = process.env) {
  const baseDir = path.join(process.cwd(), '.deployhub-storage');

  /**
   * @param {string} localPath
   * @param {string} [remoteKey]
   */
  async function upload(localPath, remoteKey) {
    const key = remoteKey || path.basename(localPath);
    const dest = path.join(baseDir, key);
    await fs.ensureDir(path.dirname(dest));
    await fs.copy(localPath, dest);
  }

  /**
   * @param {string} remoteKey
   * @param {string} localPath
   */
  async function download(remoteKey, localPath) {
    const src = path.join(baseDir, remoteKey);
    if (!(await fs.pathExists(src))) {
      throw new Error(`Local storage file not found: ${remoteKey}`);
    }
    await fs.ensureDir(path.dirname(localPath));
    await fs.copy(src, localPath);
  }

  /**
   * @param {string} remoteKey
   */
  async function verify(remoteKey) {
    return fs.pathExists(path.join(baseDir, remoteKey));
  }

  /**
   * @param {string} remoteKey
   */
  async function deleteObject(remoteKey) {
    const target = path.join(baseDir, remoteKey);
    if (await fs.pathExists(target)) {
      await fs.remove(target);
    }
  }

  async function testConnection() {
    await fs.ensureDir(baseDir);
    const testFile = path.join(baseDir, '.connection-test');
    await fs.writeFile(testFile, 'ok');
    await fs.remove(testFile);
  }

  return { upload, download, verify, delete: deleteObject, testConnection };
}

export default { createLocalProvider };
