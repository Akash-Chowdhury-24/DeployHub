import { execa } from 'execa';
import { createLogger } from '../../logger/index.js';

export function createDockerProvider(config, envName) {
  const log = createLogger('docker');

  async function deploy(artifactDir) {
    log.info('Deploying via Docker...');
    await execa('docker', ['compose', 'up', '-d', '--build'], {
      cwd: artifactDir,
      stdio: 'inherit',
    });
  }

  async function rollback(artifactDir) {
    await deploy(artifactDir);
  }

  async function healthCheck() {
    return true;
  }

  async function testConnection() {
    await execa('docker', ['info'], { stdio: 'pipe' });
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createDockerProvider };
