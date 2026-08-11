import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';
import { resolveDockerImageRef } from '../utils/docker-image.js';

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
