import chalk from 'chalk';
import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { loadConfig, loadEnv } from '../core/config.js';
import { testProvider } from '../storage/index.js';
import { getDeploymentProvider } from '../deployment/index.js';
import { PROVIDER_ENV_MAP, getRollbackWorkflowDoctorCheck } from '../utils/github-actions.js';
import { printDoctorFooter } from '../utils/author.js';
import { createLocalProvider } from '../storage/providers/local.js';
import {
  getDeploymentEnvKeys,
  getDeploymentSecretKeys,
} from '../deployment/deployment-env.js';
import { testSshConnectivity, validateSshKeyForDoctor, testSshHostReachability } from '../deployment/init-helpers.js';
import {
  buildDeployPathWriteTestCommand,
  formatDeployPathWriteFailure,
} from '../utils/shell-quote.js';
import { formatPasswordlessSudoGuidance } from '../utils/nginx.js';
import { checkImagePullability } from '../utils/docker-image-deploy.js';
import { namespaceExists } from '../utils/kubernetes-namespace.js';

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

/** @type {Set<string>} */
const SSH_DEPLOY_TYPES = new Set(['ssh', 'ec2', 'azure-vm', 'gcp-vm']);

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, unknown>} envConfig
 * @returns {string[]}
 */
function resolveSshDeployPaths(config, envConfig) {
  /** @type {string[]} */
  const paths = [];

  if (config.projectType === 'both') {
    if (envConfig.frontendDeployPath) paths.push(String(envConfig.frontendDeployPath));
    if (envConfig.backendDeployPath) paths.push(String(envConfig.backendDeployPath));
    else if (envConfig.path) paths.push(String(envConfig.path));
  } else {
    const deployPath =
      envConfig.deployPath || envConfig.path || process.env.SSH_DEPLOY_PATH;
    if (deployPath) paths.push(String(deployPath));
  }

  return [...new Set(paths.filter(Boolean))];
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {boolean}
 */
function needsNginxActivationForDeploy(config) {
  if (config.projectType === 'backend') return false;
  if (config.projectType === 'frontend' && config.framework === 'nextjs') return false;
  return true;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, unknown>} envConfig
 * @returns {Promise<CheckResult[]>}
 */
async function runDeploymentChecks(config, envName, envConfig) {
  const deployType = envConfig.type;
  if (!deployType || typeof deployType !== 'string') return [];

  /** @type {CheckResult[]} */
  const checks = [];
  const requiredKeys = getDeploymentEnvKeys(deployType, config);

  checks.push(
    await runCheck(`${deployType} env vars`, async () => {
      const missing = requiredKeys.filter((k) => {
        if (k === 'SSH_KEY_PATH') {
          return !process.env.SSH_KEY_PATH && !process.env.SSH_KEY;
        }
        return !process.env[k];
      });
      if (missing.length > 0) {
        return {
          name: `${deployType} env vars`,
          pass: false,
          message: `Missing required variables: ${missing.join(', ')} — copy .env.example to .env and fill in values (see inline comments).`,
        };
      }
      return {
        name: `${deployType} env vars`,
        pass: true,
        message: 'All required deployment variables present',
      };
    })
  );

  if (SSH_DEPLOY_TYPES.has(deployType)) {
    const host = envConfig.host || process.env.SSH_HOST;
    const user = envConfig.user || process.env.SSH_USER;
    const keyPath = envConfig.keyPath || process.env.SSH_KEY_PATH;
    const sshPort = Number(process.env.SSH_SSH_PORT || envConfig.sshPort) || 22;

    checks.push(
      await runCheck('SSH key', async () => {
        const result = await validateSshKeyForDoctor(
          keyPath ? String(keyPath) : undefined,
          process.env.SSH_KEY
        );
        return {
          name: 'SSH key',
          pass: result.ok,
          message: result.message,
        };
      })
    );

    checks.push(
      await runCheck('SSH host reachability', async () => {
        if (!host) {
          return {
            name: 'SSH host reachability',
            pass: false,
            message: 'SSH_HOST is required — set it in .env to your server IP or hostname.',
          };
        }
        const result = await testSshHostReachability(String(host), sshPort);
        return {
          name: 'SSH host reachability',
          pass: result.ok,
          message: result.message,
        };
      })
    );

    const deployPaths = resolveSshDeployPaths(config, envConfig);
    const sshUser = String(user || process.env.SSH_USER || 'your-user');

    for (const deployPath of deployPaths) {
      const checkName = `Deploy path write (${deployPath})`;
      checks.push(
        await runCheck(checkName, async () => {
          if (!host || !user) {
            return {
              name: checkName,
              pass: false,
              message: 'SSH_HOST and SSH_USER are required for deploy path write test.',
            };
          }
          if (!keyPath && !process.env.SSH_KEY) {
            return {
              name: checkName,
              pass: false,
              message: 'SSH_KEY_PATH or SSH_KEY is required for deploy path write test.',
            };
          }

          const provider = getDeploymentProvider(deployType, config, envName);
          if (!provider.runRemoteCheck) {
            return {
              name: checkName,
              pass: false,
              message: 'Deploy provider does not support remote checks.',
            };
          }

          const command = buildDeployPathWriteTestCommand(deployPath);
          const result = await provider.runRemoteCheck(command);
          if (result.pass) {
            return {
              name: checkName,
              pass: true,
              message: `Write access OK for ${deployPath}`,
            };
          }

          return {
            name: checkName,
            pass: false,
            message: formatDeployPathWriteFailure(deployPath, sshUser, result.message),
          };
        })
      );
    }

    if (needsNginxActivationForDeploy(config)) {
      checks.push(
        await runCheck('Nginx installed', async () => {
          if (!host || !user) {
            return {
              name: 'Nginx installed',
              pass: false,
              message: 'SSH_HOST and SSH_USER are required to check Nginx on the server.',
            };
          }
          if (!keyPath && !process.env.SSH_KEY) {
            return {
              name: 'Nginx installed',
              pass: false,
              message: 'SSH_KEY_PATH or SSH_KEY is required to check Nginx on the server.',
            };
          }

          const provider = getDeploymentProvider(deployType, config, envName);
          if (!provider.runRemoteCheck) {
            return {
              name: 'Nginx installed',
              pass: false,
              message: 'Deploy provider does not support remote checks.',
            };
          }

          const result = await provider.runRemoteCheck('command -v nginx >/dev/null 2>&1 && echo yes');
          if (result.pass && result.message.includes('yes')) {
            return { name: 'Nginx installed', pass: true, message: 'Nginx installed on server' };
          }
          return {
            name: 'Nginx installed',
            pass: false,
            message:
              'Nginx not found on server — install it first (e.g. sudo yum install nginx on Amazon Linux, or sudo apt install nginx on Ubuntu).',
          };
        })
      );

      checks.push(
        await runCheck('Passwordless sudo', async () => {
          if (!host || !user) {
            return {
              name: 'Passwordless sudo',
              pass: false,
              message: 'SSH_HOST and SSH_USER are required for sudo check.',
            };
          }
          if (!keyPath && !process.env.SSH_KEY) {
            return {
              name: 'Passwordless sudo',
              pass: false,
              message: 'SSH_KEY_PATH or SSH_KEY is required for sudo check.',
            };
          }

          const provider = getDeploymentProvider(deployType, config, envName);
          if (!provider.runRemoteCheck) {
            return {
              name: 'Passwordless sudo',
              pass: false,
              message: 'Deploy provider does not support remote checks.',
            };
          }

          const result = await provider.runRemoteCheck('sudo -n true');
          if (result.pass) {
            return {
              name: 'Passwordless sudo',
              pass: true,
              message: 'Non-interactive sudo available (required for Nginx config activation)',
            };
          }
          return {
            name: 'Passwordless sudo',
            pass: false,
            message: formatPasswordlessSudoGuidance(sshUser),
          };
        })
      );

      checks.push(
        await runCheck('Nginx sudo access', async () => {
          if (!host || !user) {
            return {
              name: 'Nginx sudo access',
              pass: false,
              message: 'SSH_HOST and SSH_USER are required for Nginx sudo check.',
            };
          }
          if (!keyPath && !process.env.SSH_KEY) {
            return {
              name: 'Nginx sudo access',
              pass: false,
              message: 'SSH_KEY_PATH or SSH_KEY is required for Nginx sudo check.',
            };
          }

          const provider = getDeploymentProvider(deployType, config, envName);
          if (!provider.runRemoteCheck) {
            return {
              name: 'Nginx sudo access',
              pass: false,
              message: 'Deploy provider does not support remote checks.',
            };
          }

          const nginxInstalled = await provider.runRemoteCheck('command -v nginx >/dev/null 2>&1 && echo yes');
          if (!nginxInstalled.pass || !nginxInstalled.message.includes('yes')) {
            return {
              name: 'Nginx sudo access',
              pass: false,
              message: 'Skipped — install Nginx first.',
            };
          }

          const sudoOk = await provider.runRemoteCheck('sudo -n true');
          if (!sudoOk.pass) {
            return {
              name: 'Nginx sudo access',
              pass: false,
              message: 'Skipped — configure passwordless sudo first.',
            };
          }

          const result = await provider.runRemoteCheck('sudo -n nginx -t 2>&1');
          if (result.pass) {
            return {
              name: 'Nginx sudo access',
              pass: true,
              message: 'sudo nginx -t OK (can test config before reload)',
            };
          }
          return {
            name: 'Nginx sudo access',
            pass: false,
            message: `sudo nginx -t failed — ${result.message}. Check Nginx install and sudoers (see README one-time server setup).`,
          };
        })
      );
    }

    const isBackend = config.projectType === 'backend' || config.projectType === 'both';
    if (isBackend) {
      const backendChecks = await runBackendProcessChecks(config, envName, deployType);
      checks.push(...backendChecks);
    }
  }

  if (deployType === 'docker') {
    checks.push(
      await runCheck('Docker daemon', async () => {
        try {
          const provider = getDeploymentProvider('docker', config, envName);
          await provider.testConnection();
          return { name: 'Docker daemon', pass: true, message: 'Docker daemon reachable' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            name: 'Docker daemon',
            pass: false,
            message: `Docker not reachable — ${msg}. Install Docker or set DOCKER_HOST for a remote daemon.`,
          };
        }
      })
    );
  }

  if (deployType === 'kubernetes') {
    checks.push(
      await runCheck('Kubernetes cluster', async () => {
        try {
          const provider = getDeploymentProvider('kubernetes', config, envName);
          await provider.testConnection();
          const ctx = process.env.KUBE_CONTEXT || 'current';
          const ns = process.env.KUBE_NAMESPACE || config.project || 'default';
          return {
            name: 'Kubernetes cluster',
            pass: true,
            message: `kubectl cluster-info OK (context: ${ctx}, namespace: ${ns})`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            name: 'Kubernetes cluster',
            pass: false,
            message: `kubectl cluster-info failed — ${msg}. Check KUBECONFIG path and KUBE_CONTEXT.`,
          };
        }
      })
    );

    checks.push(
      await runCheck('Kubernetes namespace', async () => {
        const ns = process.env.KUBE_NAMESPACE || config.project || 'default';
        const kubeconfig =
          process.env.KUBECONFIG || path.join(os.homedir(), '.kube', 'config');
        const context = process.env.KUBE_CONTEXT || '';
        const expanded = kubeconfig.replace(/^~/, os.homedir());
        const kubectlEnv = { ...process.env, KUBECONFIG: path.resolve(expanded) };

        /** @param {string[]} baseArgs */
        function kubectlClusterArgs(baseArgs) {
          const args = [...baseArgs];
          if (context) args.push('--context', context);
          return args;
        }

        const exists = await namespaceExists(ns, {
          kubectlArgs: kubectlClusterArgs,
          getKubectlEnv: () => kubectlEnv,
        });

        if (exists) {
          return {
            name: 'Kubernetes namespace',
            pass: true,
            message: `Namespace '${ns}' exists`,
          };
        }
        return {
          name: 'Kubernetes namespace',
          pass: true,
          message: `Namespace '${ns}' does not exist yet — deploy will prompt locally or auto-create in CI (kubectl create namespace ${ns})`,
        };
      })
    );

    checks.push(
      await runCheck('Image tag strategy', async () => {
        if (process.env.DOCKER_IMAGE_TAG) {
          return {
            name: 'Image tag strategy',
            pass: true,
            message: `DOCKER_IMAGE_TAG='${process.env.DOCKER_IMAGE_TAG}' is set explicitly — deploy will rollout-restart when the full image ref is unchanged; prefer unset for unique tags per build`,
          };
        }
        return {
          name: 'Image tag strategy',
          pass: true,
          message:
            'DOCKER_IMAGE_TAG unset — deploy will auto-generate a unique tag (git SHA → CI id → timestamp)',
        };
      })
    );

    checks.push(
      await runCheck('Container image pullable', async () => {
        const result = await checkImagePullability(config, process.env);
        return {
          name: 'Container image pullable',
          pass: result.ok,
          message: result.message,
        };
      })
    );
  }

  if (deployType === 'docker' && process.env.DOCKER_REGISTRY_USERNAME && process.env.DOCKER_REGISTRY_TOKEN) {
    checks.push(
      await runCheck('Container image pullable', async () => {
        const result = await checkImagePullability(config, process.env);
        return {
          name: 'Container image pullable',
          pass: result.ok,
          message: result.message,
        };
      })
    );
  }

  if (deployType === 'ec2' && process.env.EC2_INSTANCE_ID) {
    checks.push(
      await runCheck('EC2 API', async () => {
        const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'].filter(
          (k) => !process.env[k]
        );
        if (missing.length > 0) {
          return {
            name: 'EC2 API',
            pass: false,
            message: `EC2_INSTANCE_ID is set but missing: ${missing.join(', ')} — needed for dynamic IP lookup.`,
          };
        }
        return { name: 'EC2 API', pass: true, message: 'AWS credentials present for EC2 lookup' };
      })
    );
  }

  return checks;
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {string} [deployType]
 * @returns {Promise<CheckResult[]>}
 */
async function runBackendProcessChecks(config, envName, deployType = 'ssh') {
  const framework = resolveBackendFramework(config);
  const provider = getDeploymentProvider(deployType, config, envName);

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

          const deployChecks = await runDeploymentChecks(config, envName, env);
          results.push(...deployChecks);
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
            if (!env?.type) continue;
            required.push(...getDeploymentSecretKeys(env.type, config));
          }

          const unique = [...new Set(required)];
          const missing = unique.filter((k) => {
            if (k === 'SSH_KEY') {
              return !process.env.SSH_KEY && !process.env.SSH_KEY_PATH;
            }
            return !process.env[k];
          });
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
            message: 'Workflow file missing — run deployhub init or deployhub sync-workflows',
          };
        })
      );

      const hasStorage = (config.storage || []).length > 0;
      const hasDeploy = (config.deploy || []).length > 0;
      if (hasStorage && hasDeploy) {
        results.push(
          await runCheck('Rollback workflow', async () => {
            const check = await getRollbackWorkflowDoctorCheck(cwd, config);
            return (
              check || {
                name: 'Rollback workflow',
                pass: true,
                message: 'Skipped',
              }
            );
          })
        );
      }

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
