import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';

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
      const buildCommand = config.buildCommand || 'bundle exec rails assets:precompile';
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
      await execa('docker', ['build', '-t', `${config.project}:latest`, '.'], {
        cwd,
        stdio: 'inherit',
      });
    },
  };
}

export default { create };
