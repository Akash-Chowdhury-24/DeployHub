import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';
import { resolveDockerImageRef } from '../utils/docker-image.js';

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
      const buildCommand = config.buildCommand;
      if (buildCommand == null || String(buildCommand).trim() === '') {
        log.info('No build step required — skipping');
        return;
      }
      log.info(`Running: ${buildCommand}`);
      const [cmd, ...args] = String(buildCommand).split(' ');
      await execa(cmd, args, { cwd, stdio: 'inherit', shell: true });
    },

    async docker() {
      if (!(await fs.pathExists(path.join(cwd, 'Dockerfile')))) {
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
