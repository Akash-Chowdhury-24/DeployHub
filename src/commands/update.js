import chalk from 'chalk';
import inquirer from 'inquirer';
import { execa } from 'execa';
import semver from 'semver';

const PACKAGE_NAME = 'deployhub';

/**
 * @param {import('commander').Command} program
 */
export function registerUpdateCommand(program) {
  program
    .command('update')
    .description('Check for and install updates to DeployHub')
    .action(async () => {
      console.log(chalk.gray('Checking for updates...'));

      let latest;
      try {
        const { stdout } = await execa('npm', ['view', PACKAGE_NAME, 'version'], {
          stdio: 'pipe',
        });
        latest = stdout.trim();
      } catch {
        console.log(
          chalk.yellow(
            'Could not check npm registry. DeployHub may not be published yet.'
          )
        );
        return;
      }

      const current = '1.0.0';

      if (!semver.gt(latest, current)) {
        console.log(chalk.green(`✓ DeployHub is up to date (v${current})`));
        return;
      }

      console.log(chalk.yellow(`Update available: v${current} → v${latest}`));

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Install deployhub@${latest}?`,
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('Update cancelled.'));
        return;
      }

      await execa('npm', ['install', '-g', `${PACKAGE_NAME}@${latest}`], {
        stdio: 'inherit',
      });
      console.log(chalk.green(`✓ Updated to v${latest}`));
    });
}

export default { registerUpdateCommand };
