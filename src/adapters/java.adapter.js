import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../logger/index.js';
import { resolveDockerImageRef } from '../utils/docker-image.js';

function create(config, cwd) {
  const log = createLogger('java');

  return {
    detect() {
      return (
        fs.existsSync(path.join(cwd, 'pom.xml')) ||
        fs.existsSync(path.join(cwd, 'build.gradle'))
      );
    },

    async install() {
      log.info('Resolving Java dependencies...');
    },

    async test() {
      if (fs.existsSync(path.join(cwd, 'pom.xml'))) {
        await execa('mvn', ['test'], { cwd, stdio: 'inherit' });
      } else {
        await execa('./gradlew', ['test'], { cwd, stdio: 'inherit', shell: true });
      }
    },

    async build() {
      log.info(`Running: ${config.buildCommand}`);
      const [cmd, ...args] = config.buildCommand.split(' ');
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
