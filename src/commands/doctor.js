import chalk from 'chalk';
import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import { loadConfig, loadEnv } from '../core/config.js';
import { testProvider } from '../storage/index.js';
import { getDeploymentProvider } from '../deployment/index.js';
import { PROVIDER_ENV_MAP } from '../utils/github-actions.js';
import { PLATFORM_ENV_MAP, PLATFORM_CLI_MAP } from '../utils/platform-env.js';
import { createPlatformProvider } from '../deployment/providers/platforms/index.js';
import { isCliInstalled } from '../deployment/providers/platforms/_shared.js';
import { printDoctorFooter } from '../utils/author.js';
import { createLocalProvider } from '../storage/providers/local.js';

/**
 * @typedef {{ name: string, pass: boolean, message: string }} CheckResult
 */

/** @type {Set<string>} */
const NODE_FRAMEWORKS = new Set(['express', 'nestjs', 'fastify', 'koa', 'nextjs', 'node']);
/** @type {Set<string>} */
const PYTHON_FRAMEWORKS = new Set(['fastapi', 'django', 'flask', 'python']);
/** @type {Set<string>} */
const PHP_FRAMEWORKS = new Set(['laravel', 'symfony', 'php']);
/** @type {Set<string>} */
const JAVA_FRAMEWORKS = new Set(['spring', 'java']);

/**
 * @param {string} label
 * @param {() => Promise<CheckResult>} fn
 * @returns {Promise<CheckResult>}
 */
async function runCheck(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return {
      name: label,
      pass: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {string}
 */
function resolveBackendFramework(config) {
  return config.backend?.framework || config.framework || 'express';
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @returns {Promise<CheckResult[]>}
 */
async function runBackendProcessChecks(config, envName) {
  const framework = resolveBackendFramework(config);
  const provider = getDeploymentProvider('ssh', config, envName);

  if (!provider.runRemoteCheck) {
    return [];
  }

  /** @type {CheckResult[]} */
  const checks = [];

  if (NODE_FRAMEWORKS.has(framework)) {
    checks.push(
      await runCheck('PM2', async () => {
        const result = await provider.runRemoteCheck('pm2 --version');
        if (result.pass) {
          return { name: 'PM2', pass: true, message: 'PM2 installed on server' };
        }
        return {
          name: 'PM2',
          pass: false,
          message: 'not found — run: npm install -g pm2',
        };
      })
    );
  }

  if (PYTHON_FRAMEWORKS.has(framework)) {
    checks.push(
      await runCheck('gunicorn', async () => {
        const result = await provider.runRemoteCheck('which gunicorn || gunicorn --version');
        if (result.pass) {
          return { name: 'gunicorn', pass: true, message: 'gunicorn available' };
        }
        return {
          name: 'gunicorn',
          pass: false,
          message: 'not found — run: pip install gunicorn',
        };
      })
    );

    if (framework === 'fastapi') {
      checks.push(
        await runCheck('uvicorn', async () => {
          const result = await provider.runRemoteCheck('which uvicorn || uvicorn --version');
          if (result.pass) {
            return { name: 'uvicorn', pass: true, message: 'uvicorn available' };
          }
          return {
            name: 'uvicorn',
            pass: false,
            message: 'not found — run: pip install uvicorn',
          };
        })
      );
    }
  }

  if (PHP_FRAMEWORKS.has(framework)) {
    checks.push(
      await runCheck('php-fpm', async () => {
        const result = await provider.runRemoteCheck(
          'systemctl is-active php8.2-fpm || systemctl is-active php-fpm'
        );
        if (result.pass && result.message.includes('active')) {
          return { name: 'php-fpm', pass: true, message: 'php-fpm running' };
        }
        return { name: 'php-fpm', pass: false, message: 'php-fpm not running' };
      })
    );

    checks.push(
      await runCheck('nginx', async () => {
        const result = await provider.runRemoteCheck('systemctl is-active nginx');
        if (result.pass && result.message.includes('active')) {
          return { name: 'nginx', pass: true, message: 'nginx running' };
        }
        return { name: 'nginx', pass: false, message: 'nginx not running' };
      })
    );
  }

  if (JAVA_FRAMEWORKS.has(framework)) {
    checks.push(
      await runCheck('Java', async () => {
        const result = await provider.runRemoteCheck('java -version 2>&1');
        if (result.pass || result.message.includes('version')) {
          const versionMatch = result.message.match(/version "(\d+)/);
          const major = versionMatch ? parseInt(versionMatch[1], 10) : 0;
          if (major >= 17) {
            return { name: 'Java', pass: true, message: 'Java 17+ installed on server' };
          }
          return {
            name: 'Java',
            pass: false,
            message: `Java ${major || 'unknown'} found — Java 17+ required`,
          };
        }
        return { name: 'Java', pass: false, message: 'Java not found on server' };
      })
    );
  }

  return checks;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {string} [cwd]
 * @returns {Promise<CheckResult[]>}
 */
async function runPlatformChecks(config, envName, cwd = process.cwd()) {
  const env = config.environments[envName];
  const platform = env?.platform;
  if (!platform) return [];

  const cli = PLATFORM_CLI_MAP[platform];
  const envKeys = PLATFORM_ENV_MAP[platform] || [];
  /** @type {CheckResult[]} */
  const checks = [];

  if (cli?.binary) {
    const cliLabel = cli.binary.charAt(0).toUpperCase() + cli.binary.slice(1);
    checks.push(
      await runCheck(`${cliLabel} CLI`, async () => {
        const installed = await isCliInstalled(cli.binary);
        if (installed) {
          return { name: `${cliLabel} CLI`, pass: true, message: `${cli.binary} CLI installed` };
        }
        return {
          name: `${cliLabel} CLI`,
          pass: false,
          message: `not found — run: ${cli.globalInstall || `npm install -g ${cli.install}`}`,
        };
      })
    );
  }

  for (const key of envKeys) {
    const isToken = key.includes('TOKEN') || key.includes('KEY');
    checks.push(
      await runCheck(key, async () => {
        if (!process.env[key]) {
          return { name: key, pass: false, message: 'not set in .env' };
        }
        if (isToken && key === envKeys[0]) {
          try {
            const provider = createPlatformProvider(platform, config, envName);
            if (provider.testConnection) {
              await provider.testConnection();
              return { name: key, pass: true, message: 'token valid' };
            }
          } catch (err) {
            return {
              name: key,
              pass: false,
              message: err instanceof Error ? err.message : 'token invalid',
            };
          }
        }
        return { name: key, pass: true, message: 'present' };
      })
    );
  }

  if (platform === 'vercel') {
    checks.push(
      await runCheck('Vercel project link', async () => {
        const vercelJson = path.join(cwd, '.vercel', 'project.json');
        if (await fs.pathExists(vercelJson)) {
          return { name: 'Vercel project link', pass: true, message: '.vercel/project.json found' };
        }
        return {
          name: 'Vercel project link',
          pass: false,
          message: 'not found — run: vercel link',
        };
      })
    );
  }

  if (platform === 'firebase-hosting') {
    checks.push(
      await runCheck('firebase.json', async () => {
        if (await fs.pathExists(path.join(cwd, 'firebase.json'))) {
          return { name: 'firebase.json', pass: true, message: 'found' };
        }
        return {
          name: 'firebase.json',
          pass: false,
          message: 'missing — run deployhub init or create manually',
        };
      })
    );
  }

  try {
    const provider = createPlatformProvider(platform, config, envName);
    if (provider.testConnection && envKeys.every((k) => process.env[k])) {
      checks.push(
        await runCheck(`${platform} connection`, async () => {
          await provider.testConnection();
          if (platform === 'netlify') {
            return { name: 'NETLIFY_SITE_ID', pass: true, message: 'site found' };
          }
          if (platform === 'cloudflare-pages') {
            return { name: 'CF project', pass: true, message: 'project exists' };
          }
          if (platform === 'aws-amplify') {
            return { name: 'AMPLIFY_APP_ID', pass: true, message: 'app found in AWS' };
          }
          if (platform.startsWith('firebase')) {
            return { name: 'Firebase project', pass: true, message: 'project ID valid' };
          }
          return { name: `${platform} connection`, pass: true, message: 'connected' };
        })
      );
    }
  } catch (err) {
    if (envKeys.every((k) => process.env[k])) {
      checks.push({
        name: `${platform} connection`,
        pass: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return checks;
}

/**
 * @param {import('commander').Command} program
 */
export function registerDoctorCommand(program) {
  program
    .command('doctor')
    .description('Run pre-flight checks before deploying')
    .action(async () => {
      loadEnv();
      const cwd = process.cwd();
      /** @type {CheckResult[]} */
      const results = [];

      results.push(
        await runCheck('Git', async () => {
          await execa('git', ['--version'], { stdio: 'pipe' });
          const gitDir = path.join(cwd, '.git');
          if (!(await fs.pathExists(gitDir))) {
            return { name: 'Git', pass: false, message: 'Not a git repository' };
          }
          try {
            const { stdout } = await execa('git', ['remote', '-v'], { stdio: 'pipe' });
            if (!stdout.trim()) {
              return { name: 'Git', pass: false, message: 'No remote configured' };
            }
          } catch {
            return { name: 'Git', pass: false, message: 'Could not read git remote' };
          }
          return {
            name: 'Git',
            pass: true,
            message: 'Git installed, repo detected, remote set',
          };
        })
      );

      results.push(
        await runCheck('Docker', async () => {
          try {
            await execa('docker', ['info'], { stdio: 'pipe' });
            return { name: 'Docker', pass: true, message: 'Docker running' };
          } catch {
            return { name: 'Docker', pass: false, message: 'Docker not found or not running' };
          }
        })
      );

      results.push(
        await runCheck('Build command', async () => {
          let config;
          try {
            config = await loadConfig(cwd);
          } catch {
            return {
              name: 'Build command',
              pass: false,
              message: 'deployhub.config.json not found — run deployhub init',
            };
          }

          if (config.projectType === 'backend' && !config.buildCommand) {
            return {
              name: 'Build command',
              pass: true,
              message: 'No build step required for backend',
            };
          }

          if (!config.buildCommand) {
            return {
              name: 'Build command',
              pass: true,
              message: 'No build command configured',
            };
          }

          const pkgPath = path.join(cwd, 'package.json');
          if (await fs.pathExists(pkgPath)) {
            const pkg = await fs.readJson(pkgPath);
            const cmd = config.buildCommand.replace('npm run ', '');
            if (pkg.scripts?.[cmd] || config.buildCommand.includes(' ')) {
              return {
                name: 'Build command',
                pass: true,
                message: `"${config.buildCommand}" found in package.json`,
              };
            }
          }

          return {
            name: 'Build command',
            pass: true,
            message: `Build command configured: "${config.buildCommand}"`,
          };
        })
      );

      let config = null;
      try {
        config = await loadConfig(cwd);
      } catch {
        // handled above
      }

      if (config) {
        for (const provider of config.storage || []) {
          const label = provider.charAt(0).toUpperCase() + provider.slice(1);
          if (provider === 'aws') {
            results.push(
              await runCheck('AWS', async () => {
                const keys = PROVIDER_ENV_MAP.aws;
                const missing = keys.filter((k) => !process.env[k]);
                if (missing.length > 0) {
                  return {
                    name: 'AWS',
                    pass: false,
                    message: `Missing: ${missing.join(', ')}`,
                  };
                }
                await testProvider('aws');
                return {
                  name: 'AWS',
                  pass: true,
                  message: 'Credentials valid, bucket accessible',
                };
              })
            );
          } else if (provider === 'gdrive') {
            results.push(
              await runCheck('Google Drive', async () => {
                const keys = ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN'];
                const missing = keys.filter((k) => !process.env[k]);
                if (missing.length > 0) {
                  return {
                    name: 'Google Drive',
                    pass: false,
                    message: `Missing: ${missing.join(', ')}`,
                  };
                }
                await testProvider('gdrive');
                return { name: 'Google Drive', pass: true, message: 'Connected' };
              })
            );
          } else if (provider === 'azure') {
            results.push(
              await runCheck('Azure', async () => {
                await testProvider('azure');
                return { name: 'Azure', pass: true, message: 'Connected' };
              })
            );
          } else if (provider === 'gcp') {
            results.push(
              await runCheck('GCP', async () => {
                await testProvider('gcp');
                return { name: 'GCP', pass: true, message: 'Connected' };
              })
            );
          } else if (provider === 'dropbox') {
            results.push(
              await runCheck('Dropbox', async () => {
                await testProvider('dropbox');
                return { name: 'Dropbox', pass: true, message: 'Connected' };
              })
            );
          } else if (provider === 'local') {
            results.push(
              await runCheck('Local storage', async () => {
                await testProvider('local');
                return { name: 'Local storage', pass: true, message: 'Writable' };
              })
            );
          }
        }

        for (const envName of config.deploy || []) {
          const env = config.environments[envName];
          if (!env) continue;

          if (env.deploymentType === 'platform' || env.frontendDeploymentType === 'platform') {
            const platformChecks = await runPlatformChecks(config, envName, cwd);
            results.push(...platformChecks);
          }

          if (env.type && ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(env.type)) {
            results.push(
              await runCheck('SSH target', async () => {
                const provider = getDeploymentProvider(env.type, config, envName);
                await provider.testConnection();
                const host = env.host || process.env.SSH_HOST;
                return {
                  name: 'SSH target',
                  pass: true,
                  message: `Can reach ${host || 'host'}`,
                };
              })
            );

            const isBackend =
              config.projectType === 'backend' || config.projectType === 'both';
            if (isBackend && env.type === 'ssh') {
              const backendChecks = await runBackendProcessChecks(config, envName);
              results.push(...backendChecks);
            }
          }
        }

        results.push(
          await runCheck('Health endpoint', async () => {
            const url = config.healthCheck?.url;
            if (!url) {
              return {
                name: 'Health endpoint',
                pass: false,
                message: 'No URL configured',
              };
            }
            const response = await axios.get(url, {
              timeout: (config.healthCheck.timeout || 30) * 1000,
              validateStatus: () => true,
            });
            if (response.status >= 200 && response.status < 400) {
              return {
                name: 'Health endpoint',
                pass: true,
                message: `URL reachable (HTTP ${response.status})`,
              };
            }
            return {
              name: 'Health endpoint',
              pass: false,
              message: `URL returned HTTP ${response.status}`,
            };
          })
        );
      }

      results.push(
        await runCheck('Secrets', async () => {
          if (!config) {
            return { name: 'Secrets', pass: false, message: 'No config found' };
          }

          /** @type {string[]} */
          const required = [];
          for (const provider of config.storage || []) {
            const keys = PROVIDER_ENV_MAP[provider] || [];
            required.push(...keys);
          }
          for (const envName of config.deploy || []) {
            const env = config.environments[envName];
            if (!env) continue;

            if (env.deploymentType === 'platform' || env.frontendDeploymentType === 'platform') {
              const platform = env.platform;
              if (platform) {
                const keys = PLATFORM_ENV_MAP[platform] || [];
                required.push(...keys);
              }
            } else if (env.type) {
              const keys = PROVIDER_ENV_MAP[env.type] || [];
              required.push(...keys);
            }
          }

          const unique = [...new Set(required)];
          const missing = unique.filter((k) => !process.env[k]);
          if (missing.length > 0) {
            return {
              name: 'Secrets',
              pass: false,
              message: `Missing: ${missing.join(', ')}`,
            };
          }
          return { name: 'Secrets', pass: true, message: 'All required env vars present' };
        })
      );

      results.push(
        await runCheck('GitHub Actions', async () => {
          const workflowPath = path.join(cwd, '.github', 'workflows', 'deployhub.yml');
          if (await fs.pathExists(workflowPath)) {
            return {
              name: 'GitHub Actions',
              pass: true,
              message: 'Workflow file exists at .github/workflows/deployhub.yml',
            };
          }
          return {
            name: 'GitHub Actions',
            pass: false,
            message: 'Workflow file missing — run deployhub init',
          };
        })
      );

      results.push(
        await runCheck('Storage write', async () => {
          const provider = createLocalProvider();
          const testFile = path.join(cwd, '.deployhub-doctor-test');
          await fs.writeFile(testFile, 'test');
          const remoteKey = `doctor-test-${Date.now()}.txt`;
          await provider.upload(testFile, remoteKey);
          const ok = await provider.verify(remoteKey);
          await provider.delete(remoteKey);
          await fs.remove(testFile);
          if (ok) {
            return { name: 'Storage write', pass: true, message: 'Test upload succeeded' };
          }
          return { name: 'Storage write', pass: false, message: 'Test upload verification failed' };
        })
      );

      console.log('');
      const pad = (name) => name.padEnd(22);
      for (const r of results) {
        const icon = r.pass ? chalk.green('✓') : chalk.red('✗');
        console.log(`  Checking ${pad(r.name)}...  ${icon} ${r.message}`);
      }

      const passed = results.filter((r) => r.pass).length;
      const total = results.length;
      console.log('');
      if (passed === total) {
        console.log(chalk.green.bold(`  ✓ Ready to deploy (${passed}/${total} checks passed)`));
      } else {
        const failed = total - passed;
        console.log(
          chalk.yellow.bold(
            `  ${passed}/${total} — fix the ${failed} issue${failed > 1 ? 's' : ''} above before deploying`
          )
        );
      }
      console.log('');
      printDoctorFooter();
      console.log('');
    });
}

export default { registerDoctorCommand };
