import chalk from 'chalk';
import { loadEnv } from '../core/config.js';
import { loadConfigOrExit } from '../core/load-config-or-exit.js';
import {
  createArtifact,
  listLocalArtifacts,
  extractArtifact,
} from '../artifact/engine.js';
import { downloadArtifactEntry, loadArtifactHistory, downloadFromFirst } from '../storage/index.js';
import {
  legacyArtifactRemoteKey,
} from '../utils/build-id.js';
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
      const config = await loadConfigOrExit();
      const result = await createArtifact(config, [], process.cwd());
      console.log(chalk.green(`Artifact created: ${result.artifactDir}`));
    });

  artifact
    .command('list')
    .description('List local artifacts (add --remote to include storage history.json)')
    .option('--remote', 'Also list builds from remote history.json')
    .action(async (opts) => {
      loadEnv();
      const config = await loadConfigOrExit();
      const artifacts = await listLocalArtifacts();

      console.log(chalk.bold('\nLocal artifacts:\n'));
      if (artifacts.length === 0) {
        console.log(chalk.yellow('  (none)'));
      } else {
        for (const a of artifacts) {
          const sizeMb = (a.size / 1024 / 1024).toFixed(2);
          console.log(
            `  ${chalk.cyan(a.version)}  ${a.date}  ${a.project}  ${sizeMb} MB`
          );
          console.log(chalk.gray(`    ${a.path}`));
        }
      }

      if (opts.remote) {
        console.log(chalk.bold('\nRemote history (storage):\n'));
        try {
          const { entries: history, source } = await loadArtifactHistory(
            config.storage || [],
            config.project
          );
          if (history.length === 0) {
            console.log(
              chalk.yellow(
                '  No artifact history found for this project — you may not have deployed any builds yet.'
              )
            );
          } else {
            if (source) {
              console.log(chalk.gray(`  Source: ${source}`));
              console.log('');
            }
            for (const e of history) {
              console.log(
                `  ${chalk.cyan(e.buildId)}  semver=${e.semver}  ${e.uploadedAt || ''}`
              );
              console.log(chalk.gray(`    ${e.remoteKey}`));
            }
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`  ${detail}`));
        }
      }

      console.log('');
    });

  artifact
    .command('restore <versionOrBuildId>')
    .description('Download and extract an artifact by buildId or legacy semver')
    .action(async (versionOrBuildId) => {
      loadEnv();
      const config = await loadConfigOrExit();
      const cwd = process.cwd();
      const needle = String(versionOrBuildId).replace(/^v/i, '');

      const local = await listLocalArtifacts(cwd);
      const localMatch = local.find(
        (a) => a.version === needle || a.version === versionOrBuildId
      );

      if (localMatch) {
        const extractTo = path.join(cwd, '.deployhub-restore', `v${localMatch.version}`);
        await extractArtifact(localMatch.path, extractTo);
        console.log(chalk.green(`Restored to ${extractTo}`));
        return;
      }

      const history = await loadArtifactHistory(config.storage || [], config.project);
      const histMatch =
        history.entries.find((e) => e.buildId === needle || e.buildId === versionOrBuildId) ||
        history.entries.find((e) => e.semver === needle);

      const restoreDir = path.join(cwd, '.deployhub-restore', `v${needle}`);
      await fs.ensureDir(restoreDir);
      const zipPath = path.join(restoreDir, 'artifact.zip');

      if (histMatch) {
        console.log(`Downloading ${histMatch.buildId} from storage...`);
        const provider = await downloadArtifactEntry(
          config.storage,
          config,
          histMatch,
          zipPath
        );
        console.log(chalk.gray(`Downloaded from ${provider}`));
      } else {
        const remoteKey = legacyArtifactRemoteKey(config.project, needle);
        console.log(`Downloading legacy key ${remoteKey} from storage...`);
        const provider = await downloadFromFirst(config.storage, remoteKey, zipPath);
        console.log(chalk.gray(`Downloaded from ${provider}`));
      }

      const versionDir = path.join(restoreDir, 'artifact');
      await fs.ensureDir(versionDir);
      await fs.move(zipPath, path.join(versionDir, 'artifact.zip'));
      await extractArtifact(versionDir, path.join(restoreDir, 'extracted'));
      console.log(chalk.green(`Restored to ${restoreDir}`));
    });
}

export default { registerArtifactCommand };
