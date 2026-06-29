import chalk from 'chalk';
import { loadConfig, loadEnv } from '../core/config.js';
import {
  createArtifact,
  listLocalArtifacts,
  extractArtifact,
} from '../artifact/engine.js';
import { downloadFromFirst } from '../storage/index.js';
import fs from 'fs-extra';
import path from 'path';

/**
 * @param {import('commander').Command} program
 */
export function registerArtifactCommand(program) {
  const artifact = program
    .command('artifact')
    .description('Manage deployment artifacts');

  artifact
    .command('create')
    .description('Create artifact from current build output')
    .action(async () => {
      loadEnv();
      const config = await loadConfig();
      const result = await createArtifact(config, [], process.cwd());
      console.log(chalk.green(`Artifact created: ${result.artifactDir}`));
    });

  artifact
    .command('list')
    .description('List all artifacts')
    .action(async () => {
      loadEnv();
      const artifacts = await listLocalArtifacts();

      if (artifacts.length === 0) {
        console.log(chalk.yellow('No local artifacts found.'));
        return;
      }

      console.log(chalk.bold('\nArtifacts:\n'));
      for (const a of artifacts) {
        const sizeMb = (a.size / 1024 / 1024).toFixed(2);
        console.log(
          `  ${chalk.cyan(a.version)}  ${a.date}  ${a.project}  ${sizeMb} MB`
        );
        console.log(chalk.gray(`    ${a.path}`));
      }
      console.log('');
    });

  artifact
    .command('restore <version>')
    .description('Download and extract an artifact by version')
    .action(async (version) => {
      loadEnv();
      const config = await loadConfig();
      const cwd = process.cwd();

      const local = await listLocalArtifacts(cwd);
      const localMatch = local.find((a) => a.version === version);

      if (localMatch) {
        const extractTo = path.join(cwd, '.deployhub-restore', `v${version}`);
        await extractArtifact(localMatch.path, extractTo);
        console.log(chalk.green(`Restored to ${extractTo}`));
        return;
      }

      const remoteKey = `${config.project}/v${version}/artifact.zip`;
      const restoreDir = path.join(cwd, '.deployhub-restore', `v${version}`);
      await fs.ensureDir(restoreDir);
      const zipPath = path.join(restoreDir, 'artifact.zip');

      console.log(`Downloading v${version} from storage...`);
      const provider = await downloadFromFirst(config.storage, remoteKey, zipPath);
      console.log(chalk.gray(`Downloaded from ${provider}`));

      const versionDir = path.join(restoreDir, 'artifact');
      await fs.ensureDir(versionDir);
      await fs.move(zipPath, path.join(versionDir, 'artifact.zip'));
      await extractArtifact(versionDir, path.join(restoreDir, 'extracted'));
      console.log(chalk.green(`Restored to ${restoreDir}`));
    });
}

export default { registerArtifactCommand };
