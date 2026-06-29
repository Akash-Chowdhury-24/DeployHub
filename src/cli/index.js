#!/usr/bin/env node

import { Command } from 'commander';
import { loadEnv } from '../core/config.js';
import { registerInitCommand } from '../commands/init.js';
import { registerBuildCommand } from '../commands/build.js';
import { registerArtifactCommand } from '../commands/artifact.js';
import { registerStorageCommand } from '../commands/storage.js';
import { registerDeployCommand } from '../commands/deploy.js';
import { registerRollbackCommand } from '../commands/rollback.js';
import { registerLogsCommand } from '../commands/logs.js';
import { registerDoctorCommand } from '../commands/doctor.js';
import { registerVerifyCommand } from '../commands/verify.js';
import { registerCleanCommand } from '../commands/clean.js';
import { registerUpdateCommand } from '../commands/update.js';
import { formatVersionOutput, printBanner, shouldShowBanner } from '../utils/author.js';

loadEnv();

const program = new Command();

program
  .name('deployhub')
  .description('Zero-configuration deployment and artifact manager')
  .version(formatVersionOutput(), '-V, --version', 'output the version number');

program.hook('preAction', () => {
  if (shouldShowBanner()) {
    printBanner();
  }
});

registerInitCommand(program);
registerBuildCommand(program);
registerArtifactCommand(program);
registerStorageCommand(program);
registerDeployCommand(program);
registerRollbackCommand(program);
registerLogsCommand(program);
registerDoctorCommand(program);
registerVerifyCommand(program);
registerCleanCommand(program);
registerUpdateCommand(program);

program.parse();
