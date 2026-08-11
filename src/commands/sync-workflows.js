import chalk from 'chalk';
import { loadEnv } from '../core/config.js';
import { loadConfigOrExit } from '../core/load-config-or-exit.js';
import { getEnabledEnvironmentNames } from '../core/environments.js';
import {
  writeWorkflowFile,
  DEPLOY_WORKFLOW_FILENAME,
  ROLLBACK_WORKFLOW_FILENAME,
} from '../utils/github-actions.js';

/**
 * Regenerate GitHub Actions workflows from deployhub.config.json (no interactive init).
 * @param {import('commander').Command} program
 */
export function registerSyncWorkflowsCommand(program) {
  program
    .command('sync-workflows')
    .description(
      'Regenerate .github/workflows/deployhub.yml and deployhub-rollback.yml from deployhub.config.json'
    )
    .action(async () => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfigOrExit(cwd);

      const storage = config.storage || [];
      const environments = config.environments || {};
      // Prefer enabled environments over legacy deploy[] so every reachable env
      // gets its secrets into the regenerated workflow env blocks.
      const deploy = getEnabledEnvironmentNames(config);
      const cliSource = config.cli?.source;

      await writeWorkflowFile(storage, deploy, environments, cwd, cliSource, config);

      console.log(chalk.green('✓ Regenerated GitHub Actions workflows:'));
      console.log(`  • .github/workflows/${DEPLOY_WORKFLOW_FILENAME}`);
      console.log(`  • .github/workflows/${ROLLBACK_WORKFLOW_FILENAME}`);
      console.log('');
      console.log(
        chalk.gray(
          'Commit and push these files, then use Actions → DeployHub Rollback (workflow_dispatch) to roll back.'
        )
      );
    });
}

export default { registerSyncWorkflowsCommand };
