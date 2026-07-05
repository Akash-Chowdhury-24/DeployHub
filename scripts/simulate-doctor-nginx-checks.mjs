/**
 * Prints deployhub doctor-style output for new Nginx/sudo checks.
 * Run: node scripts/simulate-doctor-nginx-checks.mjs
 */
import chalk from 'chalk';
import { formatPasswordlessSudoGuidance } from '../src/utils/nginx.js';

console.log('');
const pad = (name) => name.padEnd(22);

console.log(`  Checking ${pad('Nginx installed')}...  ${chalk.green('✓')} Nginx installed on server`);
console.log(
  `  Checking ${pad('Passwordless sudo')}...  ${chalk.green('✓')} Non-interactive sudo available (required for Nginx config activation)`
);
console.log(
  `  Checking ${pad('Nginx sudo access')}...  ${chalk.green('✓')} sudo nginx -t OK (can test config before reload)`
);

console.log('');
console.log('  --- failing examples ---');
console.log('');
console.log(
  `  Checking ${pad('Nginx installed')}...  ${chalk.red('✗')} Nginx not found on server — install it first (e.g. sudo yum install nginx on Amazon Linux, or sudo apt install nginx on Ubuntu).`
);
console.log(
  `  Checking ${pad('Passwordless sudo')}...  ${chalk.red('✗')} ${formatPasswordlessSudoGuidance('ec2-user')}`
);
console.log('');
