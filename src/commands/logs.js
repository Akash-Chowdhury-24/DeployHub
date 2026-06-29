import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { listLocalArtifacts } from '../artifact/engine.js';

/**
 * @param {import('commander').Command} program
 */
export function registerLogsCommand(program) {
  program
    .command('logs')
    .description('Show logs from the last deployment')
    .action(async () => {
      const artifacts = await listLocalArtifacts();
      if (artifacts.length === 0) {
        console.log(chalk.yellow('No deployment logs found.'));
        return;
      }

      const latest = artifacts[0];
      const logsPath = path.join(latest.path, 'logs.txt');

      if (await fs.pathExists(logsPath)) {
        const content = await fs.readFile(logsPath, 'utf-8');
        console.log(chalk.bold(`\nDeployment logs (v${latest.version}):\n`));
        console.log(content);
      } else {
        console.log(chalk.yellow('No logs.txt found in latest artifact.'));
      }
    });
}

export default { registerLogsCommand };
