import fs from 'fs-extra';
import path from 'path';

/** Directories to skip when walking for wsgi.py / Flask entrypoints. */
const SKIP_DIRS = new Set([
  'venv',
  '.venv',
  'env',
  '.env',
  'node_modules',
  '__pycache__',
  '.git',
  '.tox',
  'site-packages',
  'dist',
  'build',
  '.eggs',
]);

/**
 * @param {string} startCommand
 * @returns {string|null} e.g. `myapp.wsgi:application` or `app:app`
 */
export function extractGunicornTarget(startCommand) {
  if (!startCommand || typeof startCommand !== 'string') return null;
  const tokens = startCommand.trim().split(/\s+/);
  const gIdx = tokens.findIndex((t) => t === 'gunicorn' || t.endsWith('/gunicorn'));
  if (gIdx < 0) return null;
  for (let i = gIdx + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      // skip flag and its value when it looks like `--bind 0.0.0.0:8000`
      if (
        t === '-b' ||
        t === '--bind' ||
        t === '-c' ||
        t === '--config' ||
        t === '-n' ||
        t === '--name' ||
        t === '-p' ||
        t === '--pid' ||
        t === '-w' ||
        t === '--workers' ||
        t === '--chdir' ||
        t === '-e' ||
        t === '--env' ||
        t === '--error-logfile' ||
        t === '--access-logfile' ||
        t === '--log-file'
      ) {
        i += 1;
      }
      continue;
    }
    // gunicorn app target is module:callable
    if (/^[A-Za-z_][\w.]*:[A-Za-z_]\w*$/.test(t)) {
      return t;
    }
  }
  return null;
}

/**
 * Walk cwd for files named `wsgi.py`, skipping venvs etc.
 * @param {string} cwd
 * @param {number} [maxDepth]
 * @returns {string[]} absolute paths
 */
function findWsgiFiles(cwd, maxDepth = 4) {
  /** @type {string[]} */
  const found = [];

  /**
   * @param {string} dir
   * @param {number} depth
   */
  function walk(dir, depth) {
    if (depth > maxDepth || found.length >= 20) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.venv') {
        // skip hidden except we already skip .venv via SKIP_DIRS
        if (ent.isDirectory()) continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name === 'wsgi.py') {
        found.push(full);
      }
    }
  }

  walk(cwd, 0);
  return found;
}

/**
 * Convert absolute wsgi.py path under cwd to gunicorn target `pkg.wsgi:application`.
 * @param {string} cwd
 * @param {string} wsgiAbs
 * @returns {string|null}
 */
export function wsgiPathToGunicornTarget(cwd, wsgiAbs) {
  const rel = path.relative(cwd, wsgiAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const noExt = rel.replace(/\.py$/i, '');
  const parts = noExt.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return null;
  // Invalid if any segment is not a Python identifier
  if (parts.some((p) => !/^[A-Za-z_]\w*$/.test(p))) return null;
  return `${parts.join('.')}:application`;
}

/**
 * Package directory containing wsgi.py relative to cwd (e.g. `myapp`), or null if root wsgi.py.
 * @param {string} cwd
 * @returns {string|null} relative dir name, or '' for root-level wsgi.py, or null if none
 */
export function detectDjangoWsgiPackageDir(cwd) {
  const wsgiAbs = pickPreferredWsgiFile(cwd);
  if (!wsgiAbs) return null;
  const rel = path.relative(cwd, path.dirname(wsgiAbs));
  if (!rel || rel === '.') return '';
  // Only copy the top-level package segment (myapp/wsgi.py → myapp)
  const top = rel.split(/[/\\]/)[0];
  return top || '';
}

/**
 * Prefer standard startproject layout (one level down from manage.py), then config/, then any.
 * @param {string} cwd
 * @returns {string|null} absolute path to wsgi.py
 */
function pickPreferredWsgiFile(cwd) {
  const files = findWsgiFiles(cwd);
  if (files.length === 0) return null;

  const hasManage = fs.existsSync(path.join(cwd, 'manage.py'));

  // Prefer <pkg>/wsgi.py directly under cwd when manage.py exists (django-admin startproject)
  if (hasManage) {
    const oneLevel = files.filter((f) => {
      const rel = path.relative(cwd, f);
      const parts = rel.split(/[/\\]/);
      return parts.length === 2 && parts[1] === 'wsgi.py';
    });
    if (oneLevel.length === 1) return oneLevel[0];
    // Prefer config/wsgi.py when present among one-level candidates (cookiecutter)
    const configOne = oneLevel.find((f) => path.basename(path.dirname(f)) === 'config');
    if (configOne) return configOne;
    if (oneLevel.length > 0) return oneLevel[0];
  }

  const configWsgi = files.find((f) => {
    const rel = path.relative(cwd, f).replace(/\\/g, '/');
    return rel === 'config/wsgi.py';
  });
  if (configWsgi) return configWsgi;

  const rootWsgi = files.find((f) => path.dirname(f) === path.resolve(cwd));
  if (rootWsgi) return rootWsgi;

  return files[0];
}

/**
 * @param {string} [cwd]
 * @returns {string} gunicorn target, e.g. `myapp.wsgi:application`
 */
export function detectDjangoWsgiTarget(cwd = process.cwd()) {
  const wsgiAbs = pickPreferredWsgiFile(cwd);
  if (!wsgiAbs) return 'config.wsgi:application';
  return wsgiPathToGunicornTarget(cwd, wsgiAbs) || 'config.wsgi:application';
}

/**
 * @param {string} filePath
 * @returns {'app'|'application'|null}
 */
function detectFlaskCallableName(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  // Prefer explicit assignment / factory patterns for `app` then `application`
  if (
    /\bapp\s*=\s*/.test(content) ||
    /\bcreate_app\s*\(/.test(content) ||
    /\bFlask\s*\(/.test(content)
  ) {
    // If both exist, prefer `application` only when `app` is absent as assignment
    if (/\bapp\s*=\s*/.test(content) || /\bFlask\s*\(/.test(content)) {
      if (/\bapplication\s*=\s*/.test(content) && !/\bapp\s*=\s*/.test(content)) {
        return 'application';
      }
      return 'app';
    }
  }
  if (/\bapplication\s*=\s*/.test(content)) return 'application';
  return null;
}

/**
 * @param {string} [cwd]
 * @returns {string} gunicorn target, e.g. `app:app`
 */
export function detectFlaskAppTarget(cwd = process.cwd()) {
  const candidates = ['app.py', 'wsgi.py', 'application.py'];
  for (const name of candidates) {
    const full = path.join(cwd, name);
    if (!fs.existsSync(full)) continue;
    const callable = detectFlaskCallableName(full);
    if (callable) {
      const mod = name.replace(/\.py$/i, '');
      return `${mod}:${callable}`;
    }
  }
  // Module package app/__init__.py or app/app.py
  const pkgInit = path.join(cwd, 'app', '__init__.py');
  if (fs.existsSync(pkgInit)) {
    const callable = detectFlaskCallableName(pkgInit);
    if (callable) return `app:${callable}`;
  }
  const pkgApp = path.join(cwd, 'app', 'app.py');
  if (fs.existsSync(pkgApp)) {
    const callable = detectFlaskCallableName(pkgApp);
    if (callable) return `app.app:${callable}`;
  }
  return 'app:app';
}

export default {
  extractGunicornTarget,
  detectDjangoWsgiTarget,
  detectFlaskAppTarget,
  detectDjangoWsgiPackageDir,
  wsgiPathToGunicornTarget,
};
