/**
 * Simulates post-fix SSH deploy failure through the same pipeline path as deployhub deploy.
 * Run: node scripts/simulate-ssh-permission-failure.mjs
 */
import chalk from 'chalk';
import { runPipeline } from '../src/core/pipeline.js';
import { createLogger } from '../src/logger/index.js';
import { formatRemoteCommandFailure } from '../src/utils/shell-quote.js';

const log = createLogger('deploy');

const stages = [
  {
    name: 'storage',
    async run() {},
  },
  {
    name: 'deploy',
    async run() {
      log.info('Deploying to dev (ec2)...');
      const sshLog = createLogger('ssh');
      sshLog.info('Deploying to ec2-user@13.233.124.107');
      sshLog.info('Frontend deploy path: /var/www/demo react project');

      const command = "mkdir -p '/var/www/demo react project'";
      sshLog.info(`$ ${command}`);

      const message = formatRemoteCommandFailure(
        command,
        1,
        "mkdir: cannot create directory '/var/www/demo': Permission denied",
        ''
      );
      sshLog.error(message);
      throw new Error(message);
    },
  },
];

const { failure } = await runPipeline(stages, {
  config: {},
  cwd: process.cwd(),
  state: {},
});

if (failure) {
  console.error(chalk.red(failure.message));
  process.exit(1);
}
