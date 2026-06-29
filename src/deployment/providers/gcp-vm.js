import { createSshProvider } from './ssh.js';

export function createGcpVmProvider(config, envName, env) {
  return createSshProvider(config, envName, env);
}

export default { createGcpVmProvider };
