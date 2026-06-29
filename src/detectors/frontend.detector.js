import fs from 'fs-extra';
import path from 'path';

/**
 * @typedef {Object} DetectorResult
 * @property {'frontend'} projectType
 * @property {string} framework
 * @property {string} language
 * @property {string|null} buildCommand
 * @property {string|null} startCommand
 * @property {string} buildOutput
 * @property {string|null} testCommand
 * @property {boolean} hasDocker
 * @property {number} port
 */

/** @type {Record<string, { deps?: string[], files?: string[], defaults: Omit<DetectorResult, 'projectType'|'framework'|'hasDocker'> & { buildCommand: string|null, startCommand: string|null, testCommand: string|null } }>} */
const FRAMEWORKS = {
  nextjs: {
    deps: ['next'],
    defaults: {
      language: 'node',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      buildOutput: '.next',
      testCommand: 'npm test',
      port: 3000,
    },
  },
  react: {
    deps: ['react'],
    excludeDeps: ['next'],
    defaults: {
      language: 'node',
      buildCommand: 'npm run build',
      startCommand: null,
      buildOutput: 'dist',
      testCommand: 'npm test',
      port: 80,
    },
  },
  vue: {
    deps: ['vue'],
    defaults: {
      language: 'node',
      buildCommand: 'npm run build',
      startCommand: null,
      buildOutput: 'dist',
      testCommand: 'npm test',
      port: 80,
    },
  },
  angular: {
    deps: ['@angular/core'],
    defaults: {
      language: 'node',
      buildCommand: 'ng build',
      startCommand: null,
      buildOutput: 'dist',
      testCommand: 'npm test',
      port: 80,
    },
  },
  svelte: {
    deps: ['svelte'],
    defaults: {
      language: 'node',
      buildCommand: 'npm run build',
      startCommand: null,
      buildOutput: 'public',
      testCommand: 'npm test',
      port: 80,
    },
  },
  astro: {
    deps: ['astro'],
    defaults: {
      language: 'node',
      buildCommand: 'astro build',
      startCommand: null,
      buildOutput: 'dist',
      testCommand: 'npm test',
      port: 80,
    },
  },
};

const DETECTION_ORDER = ['nextjs', 'react', 'vue', 'angular', 'svelte', 'astro'];

/**
 * @param {string} cwd
 * @returns {Record<string, string>|null}
 */
function readPackageDeps(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = fs.readJsonSync(pkgPath);
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/**
 * @param {string} cwd
 * @param {string} frameworkKey
 * @returns {boolean}
 */
function matchesFramework(cwd, frameworkKey) {
  const def = FRAMEWORKS[frameworkKey];
  if (!def) return false;

  if (def.deps) {
    const deps = readPackageDeps(cwd);
    if (!deps) return false;
    if (def.excludeDeps?.some((d) => deps[d])) return false;
    return def.deps.some((d) => deps[d]);
  }

  return false;
}

/**
 * @param {string} cwd
 * @returns {boolean}
 */
function isVanilla(cwd) {
  if (!fs.existsSync(path.join(cwd, 'index.html'))) return false;
  const deps = readPackageDeps(cwd);
  if (!deps) return true;
  const majorFrameworks = ['react', 'vue', '@angular/core', 'next', 'svelte', 'astro'];
  return !majorFrameworks.some((d) => deps[d]);
}

/**
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function detectFrontendFramework(cwd = process.cwd()) {
  for (const key of DETECTION_ORDER) {
    if (matchesFramework(cwd, key)) return key;
  }
  if (isVanilla(cwd)) return 'vanilla';
  return null;
}

/**
 * @param {string} framework
 * @param {string} [cwd]
 * @returns {DetectorResult}
 */
export function getFrontendInfo(framework, cwd = process.cwd()) {
  const hasDocker = fs.existsSync(path.join(cwd, 'Dockerfile'));
  const pkgPath = path.join(cwd, 'package.json');
  const scripts = fs.existsSync(pkgPath)
    ? fs.readJsonSync(pkgPath).scripts || {}
    : {};

  if (framework === 'vanilla') {
    return {
      projectType: 'frontend',
      framework: 'vanilla',
      language: 'node',
      buildCommand: null,
      startCommand: null,
      buildOutput: '.',
      testCommand: scripts.test ? 'npm test' : null,
      hasDocker,
      port: 80,
    };
  }

  const def = FRAMEWORKS[framework];
  if (!def) {
    return {
      projectType: 'frontend',
      framework,
      language: 'node',
      buildCommand: scripts.build ? 'npm run build' : null,
      startCommand: scripts.start ? 'npm start' : null,
      buildOutput: 'dist',
      testCommand: scripts.test ? 'npm test' : null,
      hasDocker,
      port: 80,
    };
  }

  let buildOutput = def.defaults.buildOutput;
  if (framework === 'react' || framework === 'vue') {
    if (fs.existsSync(path.join(cwd, 'dist'))) buildOutput = 'dist';
    else if (fs.existsSync(path.join(cwd, 'build'))) buildOutput = 'build';
  }

  return {
    projectType: 'frontend',
    framework,
    language: def.defaults.language,
    buildCommand: scripts.build ? `npm run build` : def.defaults.buildCommand,
    startCommand: scripts.start ? 'npm start' : def.defaults.startCommand,
    buildOutput,
    testCommand: scripts.test ? 'npm test' : def.defaults.testCommand,
    hasDocker,
    port: def.defaults.port,
  };
}

/**
 * @param {string} [cwd]
 * @returns {DetectorResult|null}
 */
export function detectFrontend(cwd = process.cwd()) {
  const framework = detectFrontendFramework(cwd);
  if (!framework) return null;
  return getFrontendInfo(framework, cwd);
}

/** @type {Record<string, DetectorResult>} */
export const FRONTEND_FRAMEWORK_DEFAULTS = Object.fromEntries(
  [...DETECTION_ORDER, 'vanilla'].map((key) => [key, getFrontendInfo(key)])
);

export default { detectFrontend, detectFrontendFramework, getFrontendInfo, FRONTEND_FRAMEWORK_DEFAULTS };
