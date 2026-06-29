import { execa } from 'execa';
import { createLogger } from '../../logger/index.js';

export function createKubernetesProvider(config, envName) {
  const log = createLogger('kubernetes');

  async function deploy(artifactDir) {
    log.info('Deploying to Kubernetes...');
    await execa('kubectl', ['apply', '-f', '.'], {
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
    await execa('kubectl', ['cluster-info'], { stdio: 'pipe' });
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createKubernetesProvider };
