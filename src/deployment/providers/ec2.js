import { createSshProvider } from './ssh.js';

export function createEc2Provider(config, envName, env) {
  return createSshProvider(config, envName, env);
}

export default { createEc2Provider };
