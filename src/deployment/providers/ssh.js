import { NodeSSH } from 'node-ssh';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createLogger } from '../../logger/index.js';
import { getNginxSitePath } from '../../utils/nginx.js';

/** @type {Set<string>} */
const NODE_FRAMEWORKS = new Set(['express', 'nestjs', 'fastify', 'koa', 'nextjs', 'node']);
/** @type {Set<string>} */
const PYTHON_FRAMEWORKS = new Set(['fastapi', 'django', 'flask', 'python']);
/** @type {Set<string>} */
const PHP_FRAMEWORKS = new Set(['laravel', 'symfony', 'php']);

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createSshProvider(config, envName, env = process.env) {
  const environment = config.environments[envName];
  if (!environment) {
    throw new Error(`Environment "${envName}" not found in config`);
  }

  const host = environment.host || env.SSH_HOST;
  const user = environment.user || env.SSH_USER;
  const deployPath =
    environment.deployPath ||
    environment.path ||
    env.SSH_DEPLOY_PATH ||
    '/var/www/app';
  const frontendDeployPath =
    environment.frontendDeployPath || deployPath;
  const backendDeployPath =
    environment.backendDeployPath || deployPath;
  const appName =
    environment.appName || env.SSH_APP_NAME || config.project;
  const port = environment.port || config.port || Number(env.SSH_PORT) || 3000;
  const sshKey = env.SSH_KEY;
  const keyPath = environment.keyPath || env.SSH_KEY_PATH;

  const log = createLogger('ssh');

  async function connect() {
    if (!host || !user) {
      throw new Error('SSH host and user are required. Set SSH_HOST and SSH_USER in .env');
    }

    const ssh = new NodeSSH();
    /** @type {import('node-ssh').SSHConnectOptions} */
    const connectOpts = { host, username: user };

    if (sshKey) {
      const tmpKeyPath = path.join(os.tmpdir(), 'deployhub-ssh-key');
      await fs.writeFile(tmpKeyPath, sshKey, { mode: 0o600 });
      connectOpts.privateKeyPath = tmpKeyPath;
    } else if (keyPath) {
      connectOpts.privateKeyPath = keyPath;
    }

    await ssh.connect(connectOpts);
    return ssh;
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} command
   */
  async function exec(ssh, command) {
    log.info(`$ ${command}`);
    const result = await ssh.execCommand(command);
    if (result.code !== 0 && result.code !== null) {
      log.warn(`Command exited with code ${result.code}: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   */
  function resolveFramework() {
    return (
      environment.framework ||
      config.backend?.framework ||
      config.framework ||
      'express'
    );
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   */
  function resolveStartCommand() {
    return (
      config.startCommand ||
      config.backend?.startCommand ||
      null
    );
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} targetPath
   */
  async function runBackendStartSequence(ssh, targetPath) {
    const framework = resolveFramework();
    const startCommand = resolveStartCommand();

    if (NODE_FRAMEWORKS.has(framework)) {
      await exec(ssh, `cd ${targetPath} && npm install --production`);
      const start = startCommand || 'npm start';
      if (start === 'npm start') {
        await exec(
          ssh,
          `cd ${targetPath} && pm2 restart ${appName} || pm2 start npm --name "${appName}" -- start`
        );
      } else if (start.startsWith('npm run ')) {
        const script = start.replace('npm run ', '');
        await exec(
          ssh,
          `cd ${targetPath} && pm2 restart ${appName} || pm2 start npm --name "${appName}" -- run ${script}`
        );
      } else {
        const [cmd, ...args] = start.split(' ');
        await exec(
          ssh,
          `cd ${targetPath} && pm2 restart ${appName} || pm2 start ${cmd} --name "${appName}" -- ${args.join(' ')}`
        );
      }
      await exec(ssh, 'pm2 save');
      return;
    }

    if (PYTHON_FRAMEWORKS.has(framework)) {
      await exec(ssh, `cd ${targetPath} && pip install -r requirements.txt`);
      if (framework === 'django') {
        await exec(ssh, `cd ${targetPath} && python manage.py migrate`);
      }
      if (framework === 'fastapi') {
        await exec(ssh, 'pkill uvicorn || true');
        await exec(
          ssh,
          `cd ${targetPath} && nohup uvicorn main:app --host 0.0.0.0 --port ${port} > app.log 2>&1 &`
        );
      } else {
        await exec(ssh, 'pkill gunicorn || true');
        const appTarget =
          framework === 'django' ? 'config.wsgi:application' : 'app:app';
        await exec(
          ssh,
          `cd ${targetPath} && nohup gunicorn ${appTarget} --bind 0.0.0.0:${port} --daemon`
        );
      }
      return;
    }

    if (PHP_FRAMEWORKS.has(framework)) {
      await exec(ssh, `cd ${targetPath} && composer install --no-dev`);
      if (framework === 'laravel') {
        await exec(ssh, `cd ${targetPath} && php artisan migrate --force`);
        await exec(ssh, `cd ${targetPath} && php artisan config:cache`);
      }
      await exec(ssh, 'sudo systemctl restart php8.2-fpm');
      await exec(ssh, 'sudo systemctl reload nginx');
      return;
    }

    if (framework === 'spring' || framework === 'java') {
      await exec(ssh, `cd ${targetPath} && pkill -f "*.jar" || true`);
      await exec(
        ssh,
        `cd ${targetPath} && nohup java -jar target/*.jar > app.log 2>&1 &`
      );
      return;
    }

    if (framework === 'go') {
      await exec(ssh, `cd ${targetPath} && pkill ${appName} || true`);
      await exec(
        ssh,
        `cd ${targetPath} && nohup ./bin/app > app.log 2>&1 &`
      );
      return;
    }

    if (framework === 'dotnet') {
      await exec(ssh, `cd ${targetPath} && pkill -f "dotnet" || true`);
      const dll = startCommand?.replace('dotnet ', '') || 'App.dll';
      await exec(
        ssh,
        `cd ${targetPath} && nohup dotnet ${dll} > app.log 2>&1 &`
      );
      return;
    }

    if (framework === 'rails') {
      await exec(ssh, `cd ${targetPath} && bundle install --deployment`);
      await exec(ssh, `cd ${targetPath} && pkill puma || true`);
      await exec(
        ssh,
        `cd ${targetPath} && nohup bundle exec puma -p ${port} > app.log 2>&1 &`
      );
      return;
    }

    await exec(ssh, `cd ${targetPath} && npm install --production`);
    await exec(
      ssh,
      `cd ${targetPath} && pm2 restart ${appName} || pm2 start npm --name "${appName}" -- start`
    );
    await exec(ssh, 'pm2 save');
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} targetPath
   */
  async function setupNginx(ssh, targetPath) {
    const sitePath = getNginxSitePath(config.project);
    const nginxConfRemote = `${targetPath}/nginx.conf`;

    await exec(
      ssh,
      `sudo cp ${nginxConfRemote} ${sitePath} 2>/dev/null || sudo cp ${targetPath}/nginx.conf ${sitePath}`
    );
    await exec(
      ssh,
      `sudo ln -sf ${sitePath} /etc/nginx/sites-enabled/${path.basename(sitePath)}`
    );
    await exec(ssh, 'sudo nginx -t');
    await exec(ssh, 'sudo systemctl reload nginx');
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} remoteZip
   * @param {string} targetPath
   */
  async function extractToPath(ssh, remoteZip, targetPath) {
    await exec(ssh, `mkdir -p ${targetPath}`);
    await exec(ssh, `unzip -o ${remoteZip} -d ${targetPath}`);
  }

  /**
   * @param {string} artifactDir
   */
  async function deploy(artifactDir) {
    const ssh = await connect();
    const projectType = config.projectType || 'frontend';

    try {
      const zipPath = path.join(artifactDir, 'artifact.zip');
      const remoteZip = `/tmp/deployhub-${Date.now()}.zip`;

      log.info(`Deploying to ${user}@${host}`);

      await ssh.putFile(zipPath, remoteZip);

      if (projectType === 'both') {
        const remoteStaging = `/tmp/deployhub-staging-${Date.now()}`;
        await exec(ssh, `mkdir -p ${remoteStaging}`);
        await exec(ssh, `unzip -o ${remoteZip} -d ${remoteStaging}`);

        await exec(ssh, `mkdir -p ${frontendDeployPath}`);
        await exec(
          ssh,
          `rsync -a ${remoteStaging}/ ${frontendDeployPath}/ --exclude backend || cp -r ${remoteStaging}/* ${frontendDeployPath}/`
        );

        await exec(ssh, `mkdir -p ${backendDeployPath}`);
        await exec(
          ssh,
          `rsync -a ${remoteStaging}/backend/ ${backendDeployPath}/ || cp -r ${remoteStaging}/backend/* ${backendDeployPath}/`
        );

        if (await remoteFileExists(ssh, `${frontendDeployPath}/nginx.conf`)) {
          await setupNginx(ssh, frontendDeployPath);
        }

        await runBackendStartSequence(ssh, backendDeployPath);
        await exec(ssh, `rm -rf ${remoteStaging}`);
      } else if (projectType === 'backend') {
        log.info(`Backend deploy path: ${deployPath}`);
        await extractToPath(ssh, remoteZip, deployPath);
        await runBackendStartSequence(ssh, deployPath);
      } else {
        log.info(`Frontend deploy path: ${deployPath}`);
        await extractToPath(ssh, remoteZip, deployPath);

        const framework = config.framework || 'react';
        if (framework === 'nextjs') {
          await runBackendStartSequence(ssh, deployPath);
        } else if (await remoteFileExists(ssh, `${deployPath}/nginx.conf`)) {
          await setupNginx(ssh, deployPath);
        }
      }

      await exec(ssh, `rm -f ${remoteZip}`);
      log.success('Deployment complete');
    } finally {
      ssh.dispose();
    }
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} remotePath
   */
  async function remoteFileExists(ssh, remotePath) {
    const result = await ssh.execCommand(`test -f ${remotePath} && echo yes`);
    return result.stdout.trim() === 'yes';
  }

  async function rollback(artifactDir) {
    await deploy(artifactDir);
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;

    const ssh = await connect();
    try {
      const result = await ssh.execCommand(`curl -sf -o /dev/null -w "%{http_code}" "${url}"`);
      return result.stdout.trim().startsWith('2');
    } finally {
      ssh.dispose();
    }
  }

  async function testConnection() {
    const ssh = await connect();
    ssh.dispose();
  }

  /**
   * @param {string} command
   * @returns {Promise<{ pass: boolean, message: string }>}
   */
  async function runRemoteCheck(command) {
    const ssh = await connect();
    try {
      const result = await ssh.execCommand(command);
      const ok = result.code === 0;
      return {
        pass: ok,
        message: ok ? result.stdout.trim() || 'OK' : result.stderr.trim() || result.stdout.trim() || 'Failed',
      };
    } finally {
      ssh.dispose();
    }
  }

  return {
    deploy,
    rollback,
    healthCheck,
    testConnection,
    runRemoteCheck,
    connect,
  };
}

export default { createSshProvider };
