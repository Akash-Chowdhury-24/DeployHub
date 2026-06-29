import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';

function create(config, cwd) {
  const log = createLogger('go');

  return {
    detect() {
      return fs.existsSync(path.join(cwd, 'go.mod'));
    },

    async install() {
      log.info('Downloading Go modules...');
      await execa('go', ['mod', 'download'], { cwd, stdio: 'inherit' });
    },

    async test() {
      await execa('go', ['test', './...'], { cwd, stdio: 'inherit' });
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
