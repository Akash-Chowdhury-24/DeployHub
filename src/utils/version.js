import fs from 'fs-extra';
import path from 'path';
import semver from 'semver';

/**
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function getProjectVersion(cwd = process.cwd()) {
  const pkgPath = path.join(cwd, 'package.json');
  if (await fs.pathExists(pkgPath)) {
    const pkg = await fs.readJson(pkgPath);
    if (pkg.version && semver.valid(pkg.version)) {
      return pkg.version;
    }
  }
  return getDateVersion();
}

/**
 * @returns {string}
 */
export function getDateVersion() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${y}.${m}.${d}.${h}${min}`;
}
