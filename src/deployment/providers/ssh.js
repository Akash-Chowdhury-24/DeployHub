import { NodeSSH } from 'node-ssh';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createLogger } from '../../logger/index.js';
import { getEnvSettings } from '../../core/config.js';
import {
  getNginxSitesAvailablePath,
  getNginxSitesEnabledPath,
  getNginxConfDPath,
  resolveNginxSiteName,
} from '../../utils/nginx.js';
import { resolvePm2AppName } from '../../utils/pm2-app-name.js';
import { shellQuote, formatRemoteCommandFailure } from '../../utils/shell-quote.js';
import { extractGunicornTarget } from '../../utils/python-app-target.js';
import { resolvePhpVersion } from '../../utils/php-version.js';
import {
  buildPhpFpmUnitListCommand,
  formatPhpFpmMissingError,
  formatPhpFpmVersionMismatchError,
  parsePhpFpmUnitList,
  pickPhpFpmUnitName,
  preferredPhpFpmUnitName,
} from '../../utils/php-fpm.js';

/** @type {Set<string>} */
const NODE_FRAMEWORKS = new Set(['express', 'nestjs', 'fastify', 'koa', 'nextjs', 'node']);
/** @type {Set<string>} */
const PYTHON_FRAMEWORKS = new Set(['fastapi', 'django', 'flask', 'python']);
/** @type {Set<string>} */
const PHP_FRAMEWORKS = new Set(['laravel', 'symfony', 'php']);

const sh = shellQuote;

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

  const settings = getEnvSettings(environment);
  const host = settings.host || env.SSH_HOST;
  const user = settings.user || env.SSH_USER;
  const deployPath =
    settings.deployPath ||
    settings.path ||
    env.SSH_DEPLOY_PATH ||
    '/var/www/app';
  const frontendDeployPath =
    settings.frontendDeployPath || deployPath;
  const backendDeployPath =
    settings.backendDeployPath || deployPath;
  // Env-scoped like Nginx site names — same-host multi-env must not share one PM2 name.
  const appName = resolvePm2AppName(config, envName, env);
  const port = settings.port || config.port || Number(env.SSH_PORT) || 3000;
  const sshKey = env.SSH_KEY;
  const keyPath = settings.keyPath || env.SSH_KEY_PATH;
  const sshPort = Number(env.SSH_SSH_PORT) || settings.sshPort || 22;

  const log = createLogger('ssh');

  // Defense-in-depth: never let a stuck SSH channel hang CI indefinitely.
  // Override with DEPLOYHUB_SSH_EXEC_TIMEOUT_MS (ms). Backend start/stop uses a shorter bound.
  const defaultExecTimeoutMs = Number(env.DEPLOYHUB_SSH_EXEC_TIMEOUT_MS) || 120_000;
  const startStopTimeoutMs = Math.min(
    defaultExecTimeoutMs,
    Number(env.DEPLOYHUB_SSH_START_TIMEOUT_MS) || 60_000
  );

  async function connect() {
    if (!host || !user) {
      throw new Error(
        'SSH host and user are required. Set SSH_HOST and SSH_USER in .env (see .env.example comments).'
      );
    }

    if (!sshKey && !keyPath) {
      throw new Error(
        'SSH authentication required. Set SSH_KEY_PATH (local) or SSH_KEY (CI secret) in .env — see .env.example.'
      );
    }

    const ssh = new NodeSSH();
    /** @type {import('node-ssh').SSHConnectOptions} */
    const connectOpts = { host, username: user, port: sshPort };

    if (sshKey) {
      const tmpKeyPath = path.join(os.tmpdir(), 'deployhub-ssh-key');
      await fs.writeFile(tmpKeyPath, sshKey, { mode: 0o600 });
      connectOpts.privateKeyPath = tmpKeyPath;
    } else if (keyPath) {
      const expanded = keyPath.replace(/^~/, os.homedir());
      connectOpts.privateKeyPath = path.resolve(expanded);
    }

    try {
      await ssh.connect(connectOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `SSH connection failed to ${user}@${host}:${sshPort} — ${msg}. Check SSH_HOST, SSH_USER, SSH_KEY_PATH, and that port ${sshPort} is open in your firewall/security group.`
      );
    }
    return ssh;
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} command
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function exec(ssh, command, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? defaultExecTimeoutMs;
    log.info(`$ ${command}`);

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `SSH command timed out after ${timeoutMs}ms on ${user}@${host}. ` +
              `The remote command may still be running — check the server. ` +
              `Command: ${command.length > 240 ? `${command.slice(0, 240)}…` : command}`
          )
        );
      }, timeoutMs);
    });

    let result;
    try {
      result = await Promise.race([ssh.execCommand(command), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result.code !== 0 && result.code !== null) {
      const message = formatRemoteCommandFailure(
        command,
        result.code,
        result.stderr,
        result.stdout
      );
      log.error(message);
      throw new Error(message);
    }
    return result;
  }

  /**
   * Exact marker match in a null-delimited /proc file (cmdline or environ).
   * Uses grep -xF so DEPLOYHUB_APP=myapi does not match DEPLOYHUB_APP=myapi-staging.
   *
   * @param {string} procFileExpr — e.g. `/proc/$pid/environ` or `$proc/cmdline`
   * @param {string} marker — already shell-quoted
   */
  function procHasExactMarker(procFileExpr, marker) {
    return (
      `tr '\\0' '\\n' < ${procFileExpr} 2>/dev/null | grep -qxF ${marker}`
    );
  }

  /**
   * Kill every process whose environ or cmdline contains our exact env/JVM marker.
   * Replaces `pkill -f DEPLOYHUB_APP=…` which only searches cmdline — and
   * `VAR=value nohup cmd` puts the marker in environ only, so orphans from
   * interrupted deploys (no pidfile) were never found.
   *
   * Safe against PID reuse: an unrelated process will not carry our marker.
   *
   * @param {string} markerEnvQ — shell-quoted `DEPLOYHUB_APP=…`
   * @param {string} markerJvmQ — shell-quoted `deployhub.app=…`
   * @param {string} markerJvmFlagQ — shell-quoted `-Ddeployhub.app=…`
   */
  function killByExactMarkersCmd(markerEnvQ, markerJvmQ, markerJvmFlagQ) {
    return (
      `for proc in /proc/[0-9]*; do ` +
        `pid="\${proc##*/}"; ` +
        `matched=0; ` +
        `if [ -r "$proc/environ" ] && ${procHasExactMarker('"$proc/environ"', markerEnvQ)}; then matched=1; fi; ` +
        `if [ "$matched" -eq 0 ] && [ -r "$proc/cmdline" ]; then ` +
          `if ${procHasExactMarker('"$proc/cmdline"', markerEnvQ)} ` +
          `|| ${procHasExactMarker('"$proc/cmdline"', markerJvmFlagQ)} ` +
          `|| ${procHasExactMarker('"$proc/cmdline"', markerJvmQ)}; then matched=1; fi; ` +
        `fi; ` +
        `if [ "$matched" -eq 1 ]; then kill "$pid" 2>/dev/null || true; fi; ` +
      `done`
    );
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
   * Stop a previously managed non-PM2 backend for THIS env only.
   *
   * PID-file kill is gated: we only signal a PID if /proc shows our
   * DEPLOYHUB_APP / deployhub.app marker in cmdline or environ. A stale PID
   * reused by an unrelated process is left alone (file still removed).
   *
   * Fallback scans /proc/[pid]/environ (and cmdline) for the exact marker -
   * `pkill -f` cannot see env-only markers from `VAR=value cmd` starts.
   *
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} targetPath
   */
  async function stopScopedBackendProcess(ssh, targetPath) {
    const pidFile = `${targetPath}/.deployhub.pid`;
    const markerEnv = `DEPLOYHUB_APP=${appName}`;
    const markerJvm = `deployhub.app=${appName}`;
    const markerEnvQ = sh(markerEnv);
    const markerJvmQ = sh(markerJvm);
    const markerJvmFlagQ = sh(`-D${markerJvm}`);

    // Verify-then-kill: only signal a PID if /proc shows our exact marker.
    // Exact (-xF) match so DEPLOYHUB_APP=myapi does not hit myapi-staging.
    await exec(
      ssh,
      `if [ -f ${sh(pidFile)} ]; then ` +
        `pid="$(cat ${sh(pidFile)} 2>/dev/null | tr -cd '0-9')"; ` +
        `if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then ` +
          `matched=0; ` +
          `if [ -r "/proc/$pid/environ" ] && ${procHasExactMarker(`"/proc/$pid/environ"`, markerEnvQ)}; then matched=1; fi; ` +
          `if [ "$matched" -eq 0 ] && [ -r "/proc/$pid/cmdline" ]; then ` +
            `if ${procHasExactMarker(`"/proc/$pid/cmdline"`, markerEnvQ)} ` +
            `|| ${procHasExactMarker(`"/proc/$pid/cmdline"`, markerJvmFlagQ)} ` +
            `|| ${procHasExactMarker(`"/proc/$pid/cmdline"`, markerJvmQ)}; then matched=1; fi; ` +
          `fi; ` +
          `if [ "$matched" -eq 1 ]; then kill "$pid" 2>/dev/null || true; fi; ` +
        `fi; ` +
        `rm -f ${sh(pidFile)}; ` +
      `fi`,
      { timeoutMs: startStopTimeoutMs }
    );

    // Orphan fallback: no/stale pidfile — find by exact marker in environ or cmdline.
    await exec(ssh, killByExactMarkersCmd(markerEnvQ, markerJvmQ, markerJvmFlagQ), {
      timeoutMs: startStopTimeoutMs,
    });
  }

  /**
   * After starting a backend, wait briefly and confirm the PID file's process
   * is still alive. Not a health check — only catches immediate crash.
   * `port` is closed over from createSshProvider (settings.port / config.port).
   *
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} targetPath
   * @param {string} [logFile] — defaults to targetPath/app.log
   */
  async function assertPidAliveAfterStart(ssh, targetPath, logFile) {
    const pidFile = `${targetPath}/.deployhub.pid`;
    const log = logFile || `${targetPath}/app.log`;
    const verifyCmd =
      `sleep 2; ` +
      `pid="$(cat ${sh(pidFile)} 2>/dev/null | tr -cd '0-9')"; ` +
      `if [ -z "$pid" ] || [ ! -d "/proc/$pid" ]; then ` +
      `echo "DEPLOYHUB_PROCESS_DIED: process exited immediately after start (pidfile=${sh(pidFile)}). Last lines of ${sh(log)}:"; ` +
      `tail -n 40 ${sh(log)} 2>/dev/null || echo "(no app.log)"; ` +
      `exit 1; ` +
      `fi`;

    try {
      await exec(ssh, verifyCmd, { timeoutMs: startStopTimeoutMs });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Backend process for "${appName}" died immediately after start at ${targetPath}. ` +
          `Check dependencies, entrypoint, and port ${port}.\n${detail}`
      );
    }
  }

  /**
   * Start a nohup process with DEPLOYHUB_APP marker and write PID file.
   * Marker is set in environ AND embedded as argv0 via `bash exec -a` so it
   * appears in /proc/cmdline (cmdline scans can see it). Plain
   * `VAR=value cmd` alone only puts the marker in environ.
   *
   * Critical shell-precedence note: `cd dir && nohup cmd & echo $!` is parsed
   * as `(cd dir && nohup cmd) & echo $!`. Backgrounding that AND-list leaves
   * the SSH session's bash waiting on the still-running app, so node-ssh never
   * sees channel completion (false deploy failure) even though the process
   * started. Brace-group so only nohup is backgrounded:
   * `cd dir && { nohup cmd & echo $!; }`
   *
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} targetPath
   * @param {string} command — command body after `nohup` (no trailing &)
   */
  async function startScopedNohup(ssh, targetPath, command) {
    const pidFile = `${targetPath}/.deployhub.pid`;
    const dir = sh(targetPath);
    const markerArg = sh(`DEPLOYHUB_APP=${appName}`);
    // stdin from /dev/null + redirects: avoid SSH waiting on leftover FDs.
    // bash exec -a puts DEPLOYHUB_APP=… in argv0 of the real process after exec.
    await exec(
      ssh,
      `cd ${dir} && { DEPLOYHUB_APP=${sh(appName)} nohup bash -c 'exec -a "$0" "$@"' ${markerArg} ${command} > app.log 2>&1 </dev/null & echo $! > ${sh(pidFile)}; }`,
      { timeoutMs: startStopTimeoutMs }
    );
    await assertPidAliveAfterStart(ssh, targetPath);
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} targetPath
   */
  async function runBackendStartSequence(ssh, targetPath) {
    const framework = resolveFramework();
    const startCommand = resolveStartCommand();
    const dir = sh(targetPath);
    const pidFile = `${targetPath}/.deployhub.pid`;

    if (NODE_FRAMEWORKS.has(framework)) {
      await exec(ssh, `cd ${dir} && npm install --production`);
      const start = startCommand || 'npm start';
      if (start === 'npm start') {
        await exec(
          ssh,
          `cd ${dir} && pm2 restart ${sh(appName)} || pm2 start npm --name ${sh(appName)} -- start`
        );
      } else if (start.startsWith('npm run ')) {
        const script = start.replace('npm run ', '');
        await exec(
          ssh,
          `cd ${dir} && pm2 restart ${sh(appName)} || pm2 start npm --name ${sh(appName)} -- run ${script}`
        );
      } else {
        const [cmd, ...args] = start.split(' ');
        await exec(
          ssh,
          `cd ${dir} && pm2 restart ${sh(appName)} || pm2 start ${cmd} --name ${sh(appName)} -- ${args.join(' ')}`
        );
      }
      await exec(ssh, 'pm2 save');
      return;
    }

    if (PYTHON_FRAMEWORKS.has(framework)) {
      await exec(ssh, `cd ${dir} && pip install -r requirements.txt`);
      if (framework === 'django') {
        await exec(ssh, `cd ${dir} && python manage.py migrate`);
      }
      await stopScopedBackendProcess(ssh, targetPath);
      if (framework === 'fastapi') {
        await startScopedNohup(
          ssh,
          targetPath,
          `uvicorn main:app --host 0.0.0.0 --port ${port}`
        );
      } else {
        // gunicorn --daemon writes the master PID to --pid (same .deployhub.pid).
        // --error-logfile + --capture-output give us a log to surface on immediate death
        // (daemonized stdout/stderr otherwise vanish).
        const logFile = `${targetPath}/app.log`;
        const fallbackTarget =
          framework === 'django' ? 'config.wsgi:application' : 'app:app';
        const appTarget =
          extractGunicornTarget(startCommand) || fallbackTarget;
        await exec(
          ssh,
          `cd ${dir} && DEPLOYHUB_APP=${sh(appName)} gunicorn ${appTarget} ` +
            `--name ${sh(`deployhub-${appName}`)} --bind 0.0.0.0:${port} ` +
            `--pid ${sh(pidFile)} --error-logfile ${sh(logFile)} --capture-output --daemon`,
          { timeoutMs: startStopTimeoutMs }
        );
        await assertPidAliveAfterStart(ssh, targetPath, logFile);
      }
      return;
    }

    if (PHP_FRAMEWORKS.has(framework)) {
      // PHP uses a host-wide `systemctl restart php*-fpm` (see README PHP warning).
      // Per-env isolation is Nginx site name + deploy path — not automated FPM pools.
      // startCommand (e.g. php artisan serve) is intentionally unused on SSH — FPM+nginx only.
      const phpVersion = resolvePhpVersion(config);
      const preferredUnit = preferredPhpFpmUnitName(phpVersion);
      log.info(
        `PHP backend detected — using php-fpm+nginx (prefer ${preferredUnit}, else php-fpm); ` +
          `startCommand is not used for this method`
      );

      await exec(ssh, `cd ${dir} && composer install --no-dev`);
      if (framework === 'laravel') {
        await exec(ssh, `cd ${dir} && php artisan migrate --force`);
        await exec(ssh, `cd ${dir} && php artisan config:cache`);
      }

      const fpmUnit = await resolveRemotePhpFpmUnit(ssh, phpVersion);
      log.info(`Restarting PHP-FPM service: ${fpmUnit}`);
      await exec(ssh, `sudo systemctl restart ${sh(fpmUnit)}`);
      await reloadNginx(ssh);
      return;
    }

    if (framework === 'spring' || framework === 'java') {
      await stopScopedBackendProcess(ssh, targetPath);
      // -Ddeployhub.app= embeds the env-scoped identity in the JVM command line
      // so cmdline marker scans and the PID file both target only this env.
      await startScopedNohup(
        ssh,
        targetPath,
        `java -Ddeployhub.app=${appName} -jar target/*.jar`
      );
      return;
    }

    if (framework === 'go') {
      await stopScopedBackendProcess(ssh, targetPath);
      // Binary is always ./bin/app — must NOT pkill by appName alone (that never
      // matched the process) and must NOT pkill a bare "app" (cross-env collision).
      await startScopedNohup(ssh, targetPath, './bin/app');
      return;
    }

    if (framework === 'dotnet') {
      await stopScopedBackendProcess(ssh, targetPath);
      const dll = startCommand?.replace('dotnet ', '') || 'App.dll';
      await startScopedNohup(ssh, targetPath, `dotnet ${dll}`);
      return;
    }

    if (framework === 'rails' || framework === 'ruby') {
      await exec(ssh, `cd ${dir} && bundle install --deployment`);
      await stopScopedBackendProcess(ssh, targetPath);
      await startScopedNohup(ssh, targetPath, `bundle exec puma -b tcp://0.0.0.0:${port}`);
      return;
    }

    await exec(ssh, `cd ${dir} && npm install --production`);
    await exec(
      ssh,
      `cd ${dir} && pm2 restart ${sh(appName)} || pm2 start npm --name ${sh(appName)} -- start`
    );
    await exec(ssh, 'pm2 save');
  }

  /**
   * Resolve the php-fpm systemd unit on the remote host.
   * Prefers php{version}-fpm (Debian/Ubuntu), then php-fpm (RHEL/Amazon Linux).
   * Throws if nothing usable is installed — never restarts a guessed missing unit.
   *
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} phpVersion
   * @returns {Promise<string>}
   */
  async function resolveRemotePhpFpmUnit(ssh, phpVersion) {
    const listCmd = buildPhpFpmUnitListCommand();
    const listed = await ssh.execCommand(listCmd);
    const units = parsePhpFpmUnitList(listed.stdout || '');
    const pick = pickPhpFpmUnitName(units, phpVersion);

    if (pick?.match === 'exact' || pick?.match === 'generic') {
      if (pick.match === 'generic') {
        log.info(
          `Preferred ${preferredPhpFpmUnitName(phpVersion)} not installed; ` +
            `using generic php-fpm (typical on Amazon Linux/RHEL)`
        );
      }
      return pick.unit;
    }

    if (pick?.match === 'other-version') {
      throw new Error(formatPhpFpmVersionMismatchError(phpVersion, pick.unit));
    }

    throw new Error(formatPhpFpmMissingError(phpVersion, units));
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} remotePath
   * @param {'f'|'d'} [kind='f']
   */
  async function remotePathExists(ssh, remotePath, kind = 'f') {
    const flag = kind === 'd' ? '-d' : '-f';
    const result = await ssh.execCommand(`test ${flag} ${sh(remotePath)} && echo yes`);
    return result.code === 0 && result.stdout.trim() === 'yes';
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} command
   */
  async function remoteCommandExists(ssh, command) {
    const result = await ssh.execCommand(`command -v ${sh(command)} >/dev/null 2>&1 && echo yes`);
    return result.code === 0 && result.stdout.trim() === 'yes';
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @returns {Promise<'debian'|'rhel'>}
   */
  async function detectNginxLayout(ssh) {
    if (await remotePathExists(ssh, '/etc/nginx/sites-available', 'd')) {
      return 'debian';
    }
    return 'rhel';
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   */
  async function reloadNginx(ssh) {
    await exec(ssh, 'sudo systemctl reload nginx 2>/dev/null || sudo nginx -s reload');
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} targetPath
   */
  async function setupNginx(ssh, targetPath) {
    const nginxConfRemote = `${targetPath}/nginx.conf`;

    if (!(await remoteCommandExists(ssh, 'nginx'))) {
      throw new Error(
        'Nginx is not installed on the server. Install it first (e.g. sudo yum install nginx on Amazon Linux, or sudo apt install nginx on Ubuntu), then re-run deploy.'
      );
    }

    if (!(await remotePathExists(ssh, nginxConfRemote))) {
      throw new Error(
        `Nginx config not found at ${nginxConfRemote} — artifact may be missing nginx.conf.`
      );
    }

    const layout = await detectNginxLayout(ssh);
    log.info(
      layout === 'debian'
        ? 'Detected Nginx layout: Debian/Ubuntu (sites-available)'
        : 'Detected Nginx layout: RHEL/Amazon Linux (conf.d)'
    );

    const siteName = resolveNginxSiteName(config, envName);

    if (layout === 'debian') {
      const sitePath = getNginxSitesAvailablePath(siteName);
      const enabledPath = getNginxSitesEnabledPath(siteName);
      await exec(ssh, `sudo cp ${sh(nginxConfRemote)} ${sh(sitePath)}`);
      await exec(ssh, `sudo ln -sf ${sh(sitePath)} ${sh(enabledPath)}`);
      log.info(`Nginx config installed: ${sitePath}`);
    } else {
      const confPath = getNginxConfDPath(siteName);
      await exec(ssh, `sudo cp ${sh(nginxConfRemote)} ${sh(confPath)}`);
      log.info(`Nginx config installed: ${confPath}`);
    }

    await exec(ssh, 'sudo nginx -t');
    await reloadNginx(ssh);
    log.success('Nginx config tested and reloaded');
  }

  /**
   * @param {import('node-ssh').NodeSSH} ssh
   * @param {string} remoteZip
   * @param {string} targetPath
   */
  async function extractToPath(ssh, remoteZip, targetPath) {
    await exec(ssh, `mkdir -p ${sh(targetPath)}`);
    await exec(ssh, `unzip -o ${sh(remoteZip)} -d ${sh(targetPath)}`);
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
        await exec(ssh, `mkdir -p ${sh(remoteStaging)}`);
        await exec(ssh, `unzip -o ${sh(remoteZip)} -d ${sh(remoteStaging)}`);

        await exec(ssh, `mkdir -p ${sh(frontendDeployPath)}`);
        await exec(
          ssh,
          `rsync -a ${sh(remoteStaging)}/ ${sh(frontendDeployPath)}/ --exclude backend || cp -r ${sh(remoteStaging)}/* ${sh(frontendDeployPath)}/`
        );

        await exec(ssh, `mkdir -p ${sh(backendDeployPath)}`);
        await exec(
          ssh,
          `rsync -a ${sh(remoteStaging)}/backend/ ${sh(backendDeployPath)}/ || cp -r ${sh(remoteStaging)}/backend/* ${sh(backendDeployPath)}/`
        );

        if (await remoteFileExists(ssh, `${frontendDeployPath}/nginx.conf`)) {
          await setupNginx(ssh, frontendDeployPath);
        }

        await runBackendStartSequence(ssh, backendDeployPath);
        await exec(ssh, `rm -rf ${sh(remoteStaging)}`);
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

      await exec(ssh, `rm -f ${sh(remoteZip)}`);
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
    const result = await ssh.execCommand(`test -f ${sh(remotePath)} && echo yes`);
    return result.code === 0 && result.stdout.trim() === 'yes';
  }

  async function rollback(artifactDir, _meta) {
    await deploy(artifactDir);
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;

    const ssh = await connect();
    try {
      const result = await ssh.execCommand(`curl -sf -o /dev/null -w "%{http_code}" ${sh(url)}`);
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
