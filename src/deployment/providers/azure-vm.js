import { createSshProvider } from './ssh.js';

export function createAzureVmProvider(config, envName, env) {
  return createSshProvider(config, envName, env);
}

export default { createAzureVmProvider };
