import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';

function create(config, cwd) {
  const log = createLogger('python');

  return {
    detect() {
      return (
        fs.existsSync(path.join(cwd, 'requirements.txt')) ||
        fs.existsSync(path.join(cwd, 'pyproject.toml'))
      );
    },

    async install() {
      log.info('Installing Python dependencies...');
      if (fs.existsSync(path.join(cwd, 'requirements.txt'))) {
        await execa('pip', ['install', '-r', 'requirements.txt'], {
          cwd,
          stdio: 'inherit',
        });
      }
    },

    async test() {
      if (fs.existsSync(path.join(cwd, 'pytest.ini'))) {
        await execa('pytest', [], { cwd, stdio: 'inherit' });
      } else {
        log.warn('No pytest config found, skipping tests');
      }
    },

    async build() {
      log.info(`Running: ${config.buildCommand}`);
      const [cmd, ...args] = config.buildCommand.split(' ');
      await execa(cmd, args, { cwd, stdio: 'inherit', shell: true });
    },

    async docker() {
      if (!(await fs.pathExists(path.join(cwd, 'Dockerfile')))) {
        log.warn('No Dockerfile found, skipping');
        return;
      }
      await execa('docker', ['build', '-t', `${config.project}:latest`, '.'], {
        cwd,
        stdio: 'inherit',
      });
    },
  };
}

export default { create };
