import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';

/**
 * @typedef {Object} LanguageAdapter
 * @property {function(): boolean} detect
 * @property {function(): Promise<void>} install
 * @property {function(): Promise<void>} test
 * @property {function(): Promise<void>} build
 * @property {function(): Promise<void>} docker
 */

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} cwd
 */
function create(config, cwd) {
  const log = createLogger('node');

  return {
    detect() {
      return fs.existsSync(path.join(cwd, 'package.json'));
    },

    async install() {
      log.info('Installing dependencies...');
      if (fs.existsSync(path.join(cwd, 'package-lock.json'))) {
        await execa('npm', ['ci'], { cwd, stdio: 'inherit' });
      } else {
        await execa('npm', ['install'], { cwd, stdio: 'inherit' });
      }
    },

    async test() {
      const pkg = await fs.readJson(path.join(cwd, 'package.json'));
      if (!pkg.scripts?.test) {
        log.warn('No test script found, skipping');
        return;
      }
      log.info('Running tests...');
      await execa('npm', ['test'], { cwd, stdio: 'inherit' });
    },

    async build() {
      const buildCommand =
        config.buildCommand ||
        (config.projectType === 'both' ? config.frontend?.buildCommand : null) ||
        (config.projectType === 'backend' ? config.backend?.buildCommand : null);

      if (!buildCommand) {
        log.info('No build command configured, skipping');
        return;
      }

      log.info(`Running build: ${buildCommand}`);
      const [cmd, ...args] = buildCommand.split(' ');
      await execa(cmd, args, { cwd, stdio: 'inherit', shell: true });
    },

    async docker() {
      if (!(await fs.pathExists(path.join(cwd, 'Dockerfile')))) {
        log.warn('No Dockerfile found, skipping docker build');
        return;
      }
      log.info('Building Docker image...');
      const imageName = `${config.project}:latest`;
      await execa('docker', ['build', '-t', imageName, '.'], {
        cwd,
        stdio: 'inherit',
      });
    },
  };
}

export default { create };
