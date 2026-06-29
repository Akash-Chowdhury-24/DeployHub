import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * @param {string} dir
 * @returns {Promise<Record<string, string>>}
 */
export async function generateChecksums(dir) {
  /** @type {Record<string, string>} */
  const checksums = {};

  async function walk(currentDir, base = '') {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.join(base, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
      } else {
        checksums[relativePath] = await sha256File(fullPath);
      }
    }
  }

  await walk(dir);
  return checksums;
}

/**
 * @param {Record<string, string>} checksums
 * @returns {string}
 */
export function formatChecksums(checksums) {
  return Object.entries(checksums)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, hash]) => `${hash}  ${file}`)
    .join('\n');
}
