import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  loadConfig,
  loadEnv,
  saveConfig,
} from '../core/config.js';
import {
  getEnvMethod,
  getEnvTrigger,
  isEnvEnabled,
  resolveDefaultEnvironmentName,
  validateEnvironmentName,
} from '../core/environments.js';
import { promptServerDeployment, buildServerEnvEntry } from '../deployment/init-prompts.js';
import { writeWorkflowFile } from '../utils/github-actions.js';
import { loadEnvArtifactHistory } from '../storage/index.js';
import { createLogger } from '../logger/index.js';
import {
  envUsesPrefixedSecrets,
  getDeploymentWorkflowSecretKeysForEnv,
} from '../deployment/deployment-env.js';
import {
  envHistoryRemoteKey,
  envLatestArtifactRemoteKey,
} from '../utils/build-id.js';

/**
 * Best-effort last buildId for an env from per-env deploy history.
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {Promise<string>}
 */
async function lastDeployedBuildId(config, envName) {
  try {
    const providers = config.storage || [];
    if (providers.length === 0) return '—';
    const { entries } = await loadEnvArtifactHistory(providers, config.project, envName, {
      defaultEnvironment: resolveDefaultEnvironmentName(config),
    });
    if (entries[0]?.buildId) return entries[0].buildId;
  } catch {
    // list never crashes
  }
  return '—';
}

/**
 * @param {import('commander').Command} program
 */
export function registerEnvCommand(program) {
  const env = program.command('env').description('Manage deployment environments');

  env
    .command('list')
    .description('List configured environments')
    .action(async () => {
      loadEnv();
      const config = await loadConfig();
      const names = Object.keys(config.environments || {});
      if (names.length === 0) {
        console.log(chalk.yellow('No environments configured. Run: deployhub env add <name>'));
        return;
      }

      const def = resolveDefaultEnvironmentName(config);
      console.log('');
      console.log(
        chalk.bold(
          `${'Name'.padEnd(18)} ${'Method'.padEnd(12)} ${'Status'.padEnd(10)} ${'Trigger'.padEnd(8)} Last deploy`
        )
      );
      console.log(chalk.gray('─'.repeat(72)));

      for (const name of names) {
        const entry = config.environments[name];
        const method = getEnvMethod(entry) || '?';
        const status = isEnvEnabled(entry) ? 'enabled' : 'disabled';
        const trigger = getEnvTrigger(entry);
        const last = await lastDeployedBuildId(config, name);
        const label = name === def ? `${name}*` : name;
        console.log(
          `${label.padEnd(18)} ${method.padEnd(12)} ${status.padEnd(10)} ${trigger.padEnd(8)} ${last}`
        );
      }
      console.log('');
      console.log(chalk.gray('* defaultEnvironment'));
    });

  env
    .command('add <name>')
    .description('Add a named deployment environment')
    .option(
      '--method <type>',
      'Deployment method (ssh|docker|ec2|azure-vm|gcp-vm|kubernetes); skips the type prompt'
    )
    .option(
      '--yes',
      'Non-interactive: use defaults for the chosen --method (required with --yes)'
    )
    .action(async (rawName, opts) => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      const log = createLogger('env');

      const nameCheck = validateEnvironmentName(rawName, Object.keys(config.environments || {}));
      if (!nameCheck.ok) {
        console.error(chalk.red(nameCheck.error));
        process.exit(1);
      }
      const name = nameCheck.name;

      if (opts.yes && !opts.method) {
        console.error(
          chalk.red('Non-interactive --yes requires --method <ssh|docker|ec2|azure-vm|gcp-vm|kubernetes>.')
        );
        process.exit(1);
      }

      const projectType = config.projectType || 'frontend';
      const backendConfig = config.backend || null;
      const singleConfig =
        projectType === 'both'
          ? null
          : {
              framework: config.framework,
              port: config.port,
            };

      const existingNames = Object.keys(config.environments || {});
      // Permanently grandfather the original environment's unprefixed secrets.
      if (!config.unprefixedSecretEnvironment && existingNames.length === 1) {
        config.unprefixedSecretEnvironment = existingNames[0];
      } else if (!config.unprefixedSecretEnvironment && existingNames.length === 0) {
        // First env ever — this new one stays unprefixed.
        config.unprefixedSecretEnvironment = name;
      }

      let deployAnswers;
      try {
        deployAnswers = await promptServerDeployment(
          config.project,
          projectType,
          backendConfig,
          {
            envName: name,
            existingEnvNames: Object.keys(config.environments || {}),
            deployType: opts.method,
            nonInteractive: Boolean(opts.yes),
          }
        );
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      config.environments[name] = buildServerEnvEntry(
        deployAnswers,
        projectType,
        config.project,
        backendConfig,
        singleConfig
      );

      if (!config.defaultEnvironment) {
        config.defaultEnvironment = name;
      }

      config.pipeline = config.pipeline || {};
      config.pipeline.deploy = true;

      await saveConfig(config, cwd);

      const enabledNames = Object.keys(config.environments).filter((n) =>
        isEnvEnabled(config.environments[n])
      );
      await writeWorkflowFile(
        config.storage || [],
        enabledNames,
        config.environments,
        cwd,
        config.cli?.source,
        config
      );

      log.success(`Added environment "${name}" (${deployAnswers.deployType})`);
      console.log(chalk.gray(`  defaultEnvironment: ${config.defaultEnvironment}`));
      console.log(chalk.gray('  Workflows regenerated — commit .github/workflows if using CI.'));

      const envCount = Object.keys(config.environments).length;
      if (envCount >= 2 && envUsesPrefixedSecrets(name, config)) {
        const original = config.unprefixedSecretEnvironment;
        const method = getEnvMethod(config.environments[name]);
        const newSecrets = method
          ? getDeploymentWorkflowSecretKeysForEnv(name, method, config, config.environments)
          : [];
        const requiredNew = newSecrets.filter((k) => !k.includes('OPTIONAL'));
        console.log('');
        console.log(chalk.yellow(`⚠ You now have ${envCount} environments configured.`));
        if (original) {
          console.log(
            chalk.yellow(
              `  "${original}" keeps using its existing unprefixed secrets (e.g. SSH_HOST) — no action needed.`
            )
          );
        }
        console.log(
          chalk.yellow(
            `  "${name}" requires new secrets in CI: ${requiredNew.slice(0, 8).join(', ')}${
              requiredNew.length > 8 ? ', …' : ''
            }`
          )
        );
        console.log(
          chalk.yellow(
            '  Add these to your GitHub repo secrets before running a deploy/rollback for this environment in CI.'
          )
        );
        console.log(chalk.yellow('  Run `deployhub sync-workflows` after adding them (already regenerated).'));
      }
    });

  env
    .command('enable <name>')
    .description('Enable an environment for deploy / --env all')
    .action(async (name) => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.environments[name]) {
        console.error(chalk.red(`Environment "${name}" not found.`));
        process.exit(1);
      }
      config.environments[name].enabled = true;
      await saveConfig(config, cwd);
      console.log(chalk.green(`✓ Enabled environment "${name}"`));
    });

  env
    .command('disable <name>')
    .description('Disable an environment (deploy to it will fail until re-enabled)')
    .action(async (name) => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.environments[name]) {
        console.error(chalk.red(`Environment "${name}" not found.`));
        process.exit(1);
      }
      config.environments[name].enabled = false;
      await saveConfig(config, cwd);
      console.log(chalk.yellow(`Disabled environment "${name}"`));
    });

  env
    .command('remove <name>')
    .description('Remove an environment and its rollback history reference')
    .action(async (name) => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfig(cwd);
      if (!config.environments[name]) {
        console.error(chalk.red(`Environment "${name}" not found.`));
        process.exit(1);
      }

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Remove environment "${name}"? Its per-environment rollback history will no longer be tracked by DeployHub.`,
          default: false,
        },
      ]);
      if (!confirm) {
        console.log(chalk.gray('Cancelled.'));
        return;
      }

      if (config.defaultEnvironment === name) {
        const remaining = Object.keys(config.environments).filter((n) => n !== name);
        if (remaining.length > 0) {
          console.error(
            chalk.red(
              `Cannot remove "${name}" while it is defaultEnvironment.\n` +
                `  Set a new default first (edit defaultEnvironment in deployhub.config.json), ` +
                `then run deployhub env remove ${name} again.`
            )
          );
          process.exit(1);
        }
      }

      const historyKey = envHistoryRemoteKey(config.project, name);
      const latestKey = envLatestArtifactRemoteKey(config.project, name);

      delete config.environments[name];
      if (config.defaultEnvironment === name) {
        config.defaultEnvironment = undefined;
      }
      await saveConfig(config, cwd);

      const enabledNames = Object.keys(config.environments).filter((n) =>
        isEnvEnabled(config.environments[n])
      );
      await writeWorkflowFile(
        config.storage || [],
        enabledNames,
        config.environments,
        cwd,
        config.cli?.source,
        config
      );

      console.log(chalk.green(`✓ Removed environment "${name}"`));
      console.log(
        chalk.yellow(
          `  Storage not deleted (orphaned): ${historyKey}, ${latestKey}\n` +
            '  Remove these manually from your storage provider if you no longer need rollback data.'
        )
      );
    });
}

export default { registerEnvCommand };
