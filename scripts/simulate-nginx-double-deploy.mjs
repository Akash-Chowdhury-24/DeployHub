/**
 * Simulates two consecutive deploys to the same server (idempotent nginx step).
 * Run: node scripts/simulate-nginx-double-deploy.mjs
 */
import { createLogger } from '../src/logger/index.js';
import { shellQuote } from '../src/utils/shell-quote.js';
import { getNginxConfDPath } from '../src/utils/nginx.js';

const sh = shellQuote;
const log = createLogger('ssh');
const project = 'demo-react-project';
const deployPath = '/var/www/demo-react-project';
const nginxConfRemote = `${deployPath}/nginx.conf`;
const confPath = getNginxConfDPath(project);

function runDeploy(runNumber, zipName) {
  console.log(`--- Deploy run ${runNumber} ---`);
  log.info('Deploying to ec2-user@13.233.124.107');
  log.info(`Frontend deploy path: ${deployPath}`);
  log.info(`$ mkdir -p ${sh(deployPath)}`);
  log.info(`$ unzip -o ${sh(zipName)} -d ${sh(deployPath)}`);
  log.info('Detected Nginx layout: RHEL/Amazon Linux (conf.d)');
  log.info(`$ sudo cp ${sh(nginxConfRemote)} ${sh(confPath)}`);
  log.info(`Nginx config installed: ${confPath}`);
  log.info('$ sudo nginx -t');
  log.info('nginx: configuration file /etc/nginx/nginx.conf test is successful');
  log.info('$ sudo systemctl reload nginx 2>/dev/null || sudo nginx -s reload');
  log.success('Nginx config tested and reloaded');
  log.info(`$ rm -f ${sh(zipName)}`);
  log.success('Deployment complete');
  console.log('');
}

console.log('');
runDeploy(1, '/tmp/deployhub-1111111111.zip');
runDeploy(2, '/tmp/deployhub-2222222222.zip');
