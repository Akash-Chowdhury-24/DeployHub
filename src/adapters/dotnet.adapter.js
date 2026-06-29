import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';

function create(config, cwd) {
  const log = createLogger('dotnet');

  return {
    detect() {
      const files = fs.readdirSync(cwd);
      return files.some((f) => f.endsWith('.csproj'));
    },

    async install() {
      log.info('Restoring .NET packages...');
      await execa('dotnet', ['restore'], { cwd, stdio: 'inherit' });
    },

    async test() {
      await execa('dotnet', ['test'], { cwd, stdio: 'inherit' });
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
