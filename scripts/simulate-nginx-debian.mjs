/**
 * Simulates Debian/Ubuntu Nginx activation happy path.
 * Run: node scripts/simulate-nginx-debian.mjs
 */
import { createLogger } from '../src/logger/index.js';
import { shellQuote } from '../src/utils/shell-quote.js';
import {
  getNginxSitesAvailablePath,
  getNginxSitesEnabledPath,
} from '../src/utils/nginx.js';

const sh = shellQuote;
const log = createLogger('ssh');
const project = 'my-app';
const deployPath = '/var/www/my-app';
const nginxConfRemote = `${deployPath}/nginx.conf`;
const sitePath = getNginxSitesAvailablePath(project);
const enabledPath = getNginxSitesEnabledPath(project);

console.log('');
log.info('Deploying to ubuntu@203.0.113.10');
log.info(`Frontend deploy path: ${deployPath}`);
log.info(`$ mkdir -p ${sh(deployPath)}`);
log.info(`$ unzip -o ${sh('/tmp/deployhub-1234567890.zip')} -d ${sh(deployPath)}`);
log.info('Detected Nginx layout: Debian/Ubuntu (sites-available)');
log.info(`$ sudo cp ${sh(nginxConfRemote)} ${sh(sitePath)}`);
log.info(`$ sudo ln -sf ${sh(sitePath)} ${sh(enabledPath)}`);
log.info(`Nginx config installed: ${sitePath}`);
log.info('$ sudo nginx -t');
log.info('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok');
log.info('nginx: configuration file /etc/nginx/nginx.conf test is successful');
log.info('$ sudo systemctl reload nginx 2>/dev/null || sudo nginx -s reload');
log.success('Nginx config tested and reloaded');
log.info(`$ rm -f ${sh('/tmp/deployhub-1234567890.zip')}`);
log.success('Deployment complete');
console.log('');
