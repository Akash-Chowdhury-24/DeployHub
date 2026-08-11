import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';
import { resolveDockerImageRef } from '../utils/docker-image.js';

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} cwd
 */
function create(config, cwd) {
  const log = createLogger('rails');

  return {
    detect() {
      return (
        fs.existsSync(path.join(cwd, 'Gemfile')) &&
        (fs.existsSync(path.join(cwd, 'config.ru')) ||
          fs.existsSync(path.join(cwd, 'config', 'application.rb')))
      );
    },

    async install() {
      log.info('Installing Ruby dependencies...');
      await execa('bundle', ['install'], { cwd, stdio: 'inherit' });
    },

    async test() {
      if (await fs.pathExists(path.join(cwd, 'spec'))) {
        log.info('Running RSpec tests...');
        await execa('bundle', ['exec', 'rspec'], { cwd, stdio: 'inherit' });
        return;
      }
      if (await fs.pathExists(path.join(cwd, 'test'))) {
        log.info('Running Rails tests...');
        await execa('bundle', ['exec', 'rails', 'test'], { cwd, stdio: 'inherit' });
        return;
      }
      log.warn('No spec/ or test/ directory found, skipping tests');
    },

    async build() {
      // Explicit null/"" means skip (API-only Rails, etc.). Undefined keeps the
      // conventional assets:precompile default from the Rails detector.
      if (config.buildCommand === null || config.buildCommand === '') {
        log.info('No build step required — skipping');
        return;
      }
      const buildCommand =
        config.buildCommand || 'bundle exec rails assets:precompile';
      if (!String(buildCommand).trim()) {
        log.info('No build step required — skipping');
        return;
      }
      log.info(`Running build: ${buildCommand}`);
      const [cmd, ...args] = String(buildCommand).split(' ');
      await execa(cmd, args, { cwd, stdio: 'inherit', shell: true });
    },

    async docker() {
      if (!(await fs.pathExists(path.join(cwd, 'Dockerfile')))) {
        log.warn('No Dockerfile found, skipping docker build');
        return;
      }
      const { fullImage, latestImage } = resolveDockerImageRef(config);
      log.info(`Building Docker image (${fullImage})...`);
      await execa('docker', ['build', '-t', fullImage, '.'], {
        cwd,
        stdio: 'inherit',
      });
      if (fullImage !== latestImage) {
        await execa('docker', ['tag', fullImage, latestImage], { stdio: 'pipe' });
      }
    },
  };
}

export default { create };
