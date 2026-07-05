/**
 * Prints deployhub doctor-style output for the deploy path write check (pass + fail).
 * Run: node scripts/simulate-doctor-write-check.mjs
 */
import chalk from 'chalk';
import { formatDeployPathWriteFailure } from '../src/utils/shell-quote.js';

console.log('');
const pad = (name) => name.padEnd(22);

const passPath = '/var/www/my-app';
const failPath = '/var/www/demo react project';
const sshUser = 'ec2-user';

console.log(
  `  Checking ${pad(`Deploy path write (${passPath})`)}...  ${chalk.green('✓')} Write access OK for ${passPath}`
);

const failDetail = "mkdir: cannot create directory '/var/www/demo': Permission denied";
const failMessage = formatDeployPathWriteFailure(failPath, sshUser, failDetail);
console.log(
  `  Checking ${pad(`Deploy path write (${failPath})`)}...  ${chalk.red('✗')} ${failMessage}`
);
console.log('');
