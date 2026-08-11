import chalk from 'chalk';
import { loadEnv } from '../core/config.js';
import { loadConfigOrExit } from '../core/load-config-or-exit.js';
import { resolveEnvTargets } from '../core/environments.js';
import {
  rollbackToVersion,
  formatRollbackAllSummary,
} from '../utils/rollback/engine.js';
import { createLogger } from '../logger/index.js';
import axios from 'axios';

/**
 * @param {import('commander').Command} program
 */
export function registerRollbackCommand(program) {
  program
    .command('rollback [versionOrBuildId]')
    .description(
      'Rollback to a previous artifact build (omit arg = previous build; use exact buildId if semver is ambiguous)'
    )
    .option(
      '--env <name>',
      'Environment to roll back (name, or "all" for every enabled environment independently)'
    )
    .action(async (versionOrBuildId, opts) => {
      loadEnv();
      const config = await loadConfigOrExit();
      const log = createLogger('rollback');

      let targets;
      let skippedDisabled;
      try {
        ({ targets, skippedDisabled } = resolveEnvTargets(config, opts.env));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      for (const name of skippedDisabled) {
        log.info(`Skipping disabled environment "${name}"`);
      }

      if (targets.length === 0) {
        console.error(chalk.red('No enabled environments to roll back.'));
        process.exit(1);
      }

      const isAll = opts.env === 'all';

      try {
        const { results, failures } = await rollbackToVersion(
          config,
          versionOrBuildId,
          process.cwd(),
          {
            envNames: targets,
            // --env all: attempt every enabled env independently; summarize at end.
            continueOnError: isAll,
          }
        );

        if (isAll) {
          const summary = formatRollbackAllSummary(
            results || [],
            failures || [],
            skippedDisabled
          );
          console.log('');
          console.log(summary);
          if ((failures || []).length > 0) {
            process.exit(1);
          }
        } else {
          for (const r of results || []) {
            if (!versionOrBuildId) {
              console.log(
                chalk.gray(`Rolled back ${r.envName} to previous build: ${r.entry.buildId}`)
              );
            }
          }

          if (config.healthCheck?.url) {
            try {
              const response = await axios.get(config.healthCheck.url, {
                timeout: (config.healthCheck.timeout || 30) * 1000,
                validateStatus: () => true,
              });
              if (response.status >= 200 && response.status < 400) {
                console.log(chalk.green(`Health check passed: HTTP ${response.status}`));
              } else {
                console.log(chalk.yellow(`Health check returned HTTP ${response.status}`));
              }
            } catch (err) {
              console.log(
                chalk.yellow(
                  `Health check failed: ${err instanceof Error ? err.message : String(err)}`
                )
              );
            }
          }

          const summary = (results || [])
            .map((r) => `${r.envName}→${r.entry.buildId}`)
            .join(', ');
          console.log(chalk.green(`✓ Rolled back: ${summary}`));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

export default { registerRollbackCommand };
