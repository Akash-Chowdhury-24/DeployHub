import fs from 'fs-extra';
import path from 'path';
import { detectFrontend } from './frontend.detector.js';
import { detectBackend } from './backend.detector.js';

/**
 * @typedef {Object} DetectionResult
 * @property {'frontend'|'backend'} [projectType]
 * @property {string} framework
 * @property {string} [language]
 * @property {string|null} [buildCommand]
 * @property {string|null} [startCommand]
 * @property {string} buildOutput
 * @property {string|null} [testCommand]
 * @property {boolean} hasDocker
 * @property {number} [port]
 */

/**
 * @param {string} [cwd]
 * @returns {Promise<DetectionResult|null>}
 */
export async function detectFramework(cwd = process.cwd()) {
  const frontend = detectFrontend(cwd);
  if (frontend) return frontend;

  const backend = detectBackend(cwd);
  if (backend) return backend;

  const legacyDetectors = [
    (await import('./react.js')).default,
    (await import('./vue.js')).default,
    (await import('./angular.js')).default,
    (await import('./nextjs.js')).default,
    (await import('./node.js')).default,
    (await import('./python.js')).default,
    (await import('./php.js')).default,
    (await import('./java.js')).default,
    (await import('./go.js')).default,
    (await import('./dotnet.js')).default,
  ];

  for (const detector of legacyDetectors) {
    if (detector.detect(cwd)) {
      const info = detector.getInfo(cwd);
      return {
        ...info,
        projectType: info.framework === 'node' ? 'backend' : 'frontend',
        language: info.framework,
        startCommand: null,
        testCommand: 'npm test',
        port: 3000,
      };
    }
  }

  return null;
}

/**
 * @param {string} [cwd]
 * @returns {Promise<DetectionResult|null>}
 */
export async function detectProjectType(cwd = process.cwd()) {
  return detectFramework(cwd);
}

/**
 * @param {string} [cwd]
 * @returns {Promise<boolean>}
 */
export async function hasDockerfile(cwd = process.cwd()) {
  return fs.pathExists(path.join(cwd, 'Dockerfile'));
}

export { detectFrontend, detectBackend };

export default { detectFramework, detectProjectType, hasDockerfile, detectFrontend, detectBackend };
