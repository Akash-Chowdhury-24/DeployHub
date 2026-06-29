import fs from 'fs-extra';
import path from 'path';

/**
 * @typedef {Object} BackendDetectorResult
 * @property {'backend'} projectType
 * @property {string} framework
 * @property {string} language
 * @property {string|null} buildCommand
 * @property {string|null} startCommand
 * @property {string} buildOutput
 * @property {string|null} testCommand
 * @property {boolean} hasDocker
 * @property {number} port
 */

/** @type {Record<string, { detect: (cwd: string) => boolean, defaults: Omit<BackendDetectorResult, 'projectType'|'framework'|'hasDocker'> }>} */
const FRAMEWORKS = {
  nestjs: {
    detect: (cwd) => hasPackageDep(cwd, '@nestjs/core'),
    defaults: {
      language: 'node',
      buildCommand: 'nest build',
      startCommand: 'node dist/main',
      buildOutput: 'dist',
      testCommand: 'npm test',
      port: 3000,
    },
  },
  express: {
    detect: (cwd) => hasPackageDep(cwd, 'express'),
    defaults: {
      language: 'node',
      buildCommand: null,
      startCommand: 'npm start',
      buildOutput: '.',
      testCommand: 'npm test',
      port: 3000,
    },
  },
  fastify: {
    detect: (cwd) => hasPackageDep(cwd, 'fastify'),
    defaults: {
      language: 'node',
      buildCommand: null,
      startCommand: 'npm start',
      buildOutput: '.',
      testCommand: 'npm test',
      port: 3000,
    },
  },
  koa: {
    detect: (cwd) => hasPackageDep(cwd, 'koa'),
    defaults: {
      language: 'node',
      buildCommand: null,
      startCommand: 'npm start',
      buildOutput: '.',
      testCommand: 'npm test',
      port: 3000,
    },
  },
  fastapi: {
    detect: (cwd) => fileContains(cwd, 'requirements.txt', 'fastapi'),
    defaults: {
      language: 'python',
      buildCommand: null,
      startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000',
      buildOutput: '.',
      testCommand: 'pytest',
      port: 8000,
    },
  },
  django: {
    detect: (cwd) => fileContains(cwd, 'requirements.txt', 'django'),
    defaults: {
      language: 'python',
      buildCommand: null,
      startCommand: 'gunicorn config.wsgi:application --bind 0.0.0.0:8000',
      buildOutput: '.',
      testCommand: 'python manage.py test',
      port: 8000,
    },
  },
  flask: {
    detect: (cwd) => fileContains(cwd, 'requirements.txt', 'flask'),
    defaults: {
      language: 'python',
      buildCommand: null,
      startCommand: 'gunicorn app:app --bind 0.0.0.0:5000',
      buildOutput: '.',
      testCommand: 'pytest',
      port: 5000,
    },
  },
  laravel: {
    detect: (cwd) => hasComposerPackage(cwd, 'laravel/framework'),
    defaults: {
      language: 'php',
      buildCommand: null,
      startCommand: 'php artisan serve',
      buildOutput: '.',
      testCommand: 'php artisan test',
      port: 80,
    },
  },
  symfony: {
    detect: (cwd) => hasComposerPackage(cwd, 'symfony/framework-bundle'),
    defaults: {
      language: 'php',
      buildCommand: null,
      startCommand: 'php-fpm',
      buildOutput: '.',
      testCommand: 'php bin/phpunit',
      port: 80,
    },
  },
  spring: {
    detect: (cwd) => fileContains(cwd, 'pom.xml', 'spring-boot'),
    defaults: {
      language: 'java',
      buildCommand: 'mvn package',
      startCommand: 'java -jar target/*.jar',
      buildOutput: 'target',
      testCommand: 'mvn test',
      port: 8080,
    },
  },
  go: {
    detect: (cwd) => fs.existsSync(path.join(cwd, 'go.mod')),
    defaults: {
      language: 'go',
      buildCommand: 'go build -o bin/app .',
      startCommand: './bin/app',
      buildOutput: 'bin',
      testCommand: 'go test ./...',
      port: 8080,
    },
  },
  dotnet: {
    detect: (cwd) => {
      try {
        return fs.readdirSync(cwd).some((f) => f.endsWith('.csproj'));
      } catch {
        return false;
      }
    },
    defaults: {
      language: 'dotnet',
      buildCommand: 'dotnet publish -c Release -o publish',
      startCommand: 'dotnet App.dll',
      buildOutput: 'publish',
      testCommand: 'dotnet test',
      port: 5000,
    },
  },
  rails: {
    detect: (cwd) => fileContains(cwd, 'Gemfile', 'rails'),
    defaults: {
      language: 'ruby',
      buildCommand: 'bundle exec rake assets:precompile',
      startCommand: 'bundle exec puma',
      buildOutput: '.',
      testCommand: 'bundle exec rspec',
      port: 3000,
    },
  },
};

const DETECTION_ORDER = [
  'nestjs',
  'express',
  'fastify',
  'koa',
  'fastapi',
  'django',
  'flask',
  'laravel',
  'symfony',
  'spring',
  'go',
  'dotnet',
  'rails',
];

/**
 * @param {string} cwd
 * @param {string} dep
 */
function hasPackageDep(cwd, dep) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const pkg = fs.readJsonSync(pkgPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return !!deps[dep];
}

/**
 * @param {string} cwd
 * @param {string} filename
 * @param {string} needle
 */
function fileContains(cwd, filename, needle) {
  const filePath = path.join(cwd, filename);
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
  return content.includes(needle.toLowerCase());
}

/**
 * @param {string} cwd
 * @param {string} packageName
 */
function hasComposerPackage(cwd, packageName) {
  const composerPath = path.join(cwd, 'composer.json');
  if (!fs.existsSync(composerPath)) return false;
  const composer = fs.readJsonSync(composerPath);
  const deps = { ...composer.require, ...composer['require-dev'] };
  return !!deps[packageName];
}

/**
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function detectBackendFramework(cwd = process.cwd()) {
  for (const key of DETECTION_ORDER) {
    if (FRAMEWORKS[key].detect(cwd)) return key;
  }
  return null;
}

/**
 * @param {string} framework
 * @param {string} [cwd]
 * @returns {BackendDetectorResult}
 */
export function getBackendInfo(framework, cwd = process.cwd()) {
  const hasDocker = fs.existsSync(path.join(cwd, 'Dockerfile'));
  const def = FRAMEWORKS[framework];

  if (!def) {
    return {
      projectType: 'backend',
      framework,
      language: 'node',
      buildCommand: null,
      startCommand: 'npm start',
      buildOutput: '.',
      testCommand: 'npm test',
      hasDocker,
      port: 3000,
    };
  }

  const pkgPath = path.join(cwd, 'package.json');
  const scripts = fs.existsSync(pkgPath)
    ? fs.readJsonSync(pkgPath).scripts || {}
    : {};

  let buildCommand = def.defaults.buildCommand;
  let startCommand = def.defaults.startCommand;
  let testCommand = def.defaults.testCommand;

  if (def.defaults.language === 'node') {
    if (scripts.build) buildCommand = 'npm run build';
    if (scripts.start) startCommand = 'npm start';
    if (scripts.test) testCommand = 'npm test';
  }

  return {
    projectType: 'backend',
    framework,
    language: def.defaults.language,
    buildCommand,
    startCommand,
    buildOutput: def.defaults.buildOutput,
    testCommand,
    hasDocker,
    port: def.defaults.port,
  };
}

/**
 * @param {string} [cwd]
 * @returns {BackendDetectorResult|null}
 */
export function detectBackend(cwd = process.cwd()) {
  const framework = detectBackendFramework(cwd);
  if (!framework) return null;
  return getBackendInfo(framework, cwd);
}

/** @type {Record<string, BackendDetectorResult>} */
export const BACKEND_FRAMEWORK_DEFAULTS = Object.fromEntries(
  DETECTION_ORDER.map((key) => [key, getBackendInfo(key)])
);

export default {
  detectBackend,
  detectBackendFramework,
  getBackendInfo,
  BACKEND_FRAMEWORK_DEFAULTS,
};
