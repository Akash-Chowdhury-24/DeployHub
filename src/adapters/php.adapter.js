import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';

function create(config, cwd) {
  const log = createLogger('php');

  return {
    detect() {
      return fs.existsSync(path.join(cwd, 'composer.json'));
    },

    async install() {
      log.info('Running composer install...');
      await execa('composer', ['install', '--no-dev'], {
        cwd,
        stdio: 'inherit',
      });
    },

    async test() {
      log.warn('PHP tests not configured, skipping');
    },

    async build() {
      log.info(`Running: ${config.buildCommand}`);
      const [cmd, ...args] = config.buildCommand.split(' ');
      await execa(cmd, args, { cwd, stdio: 'inherit', shell: true });
    },

    async docker() {
      if (await fs.pathExists(path.join(cwd, 'Dockerfile'))) {
        await execa('docker', ['build', '-t', `${config.project}:latest`, '.'], {
          cwd,
          stdio: 'inherit',
        });
      }
    },
  };
}

export default { create };
