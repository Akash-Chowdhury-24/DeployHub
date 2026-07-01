import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { saveConfig } from '../core/config.js';
import { detectFrontend, detectBackend } from '../detectors/index.js';
import {
  getFrontendInfo,
} from '../detectors/frontend.detector.js';
import {
  getBackendInfo,
} from '../detectors/backend.detector.js';
import { getProjectVersion } from '../utils/version.js';
import {
  writeWorkflowFile,
  getRequiredSecrets,
  generateEnvExampleContent,
  guessCliGithubRepo,
  addDeployhubToPackageJson,
} from '../utils/github-actions.js';
import {
  promptPlatformQuestions,
  appendPlatformEnvExample,
  showPlatformComparison,
  suggestHealthUrl,
  PLATFORM_CHOICES,
} from '../utils/init-platform.js';
import { printAuthorFooter } from '../utils/author.js';
import { ensureFirebaseJson } from '../utils/firebase-config-generator.js';
import { generateNginxConfig } from '../utils/nginx.js';

const FRONTEND_CHOICES = [
  { name: 'React', value: 'react' },
  { name: 'Vue', value: 'vue' },
  { name: 'Angular', value: 'angular' },
  { name: 'Next.js', value: 'nextjs' },
  { name: 'Svelte', value: 'svelte' },
  { name: 'Astro', value: 'astro' },
  { name: 'Vanilla JS / HTML', value: 'vanilla' },
  { name: "Other (I'll configure manually)", value: 'other' },
];

const BACKEND_CHOICES = [
  { name: 'Node.js — Express', value: 'express' },
  { name: 'Node.js — NestJS', value: 'nestjs' },
  { name: 'Node.js — Fastify', value: 'fastify' },
  { name: 'Node.js — Koa', value: 'koa' },
  { name: 'Python — FastAPI', value: 'fastapi' },
  { name: 'Python — Django', value: 'django' },
  { name: 'Python — Flask', value: 'flask' },
  { name: 'PHP — Laravel', value: 'laravel' },
  { name: 'PHP — Symfony', value: 'symfony' },
  { name: 'Java — Spring Boot', value: 'spring' },
  { name: 'Go', value: 'go' },
  { name: '.NET (ASP.NET Core)', value: 'dotnet' },
  { name: 'Ruby on Rails', value: 'rails' },
  { name: "Other (I'll configure manually)", value: 'other' },
];

const PROJECT_TYPE_CHOICES = [
  { name: 'Frontend only', value: 'frontend' },
  { name: 'Backend only', value: 'backend' },
  { name: 'Both (monorepo / fullstack)', value: 'both' },
];

/**
 * @param {'frontend'|'backend'} side
 * @param {string} [cwd]
 * @returns {string|null}
 */
function detectSideFramework(side, cwd) {
  if (side === 'frontend') {
    return detectFrontend(cwd)?.framework || null;
  }
  return detectBackend(cwd)?.framework || null;
}

/**
 * @param {string} framework
 * @param {'frontend'|'backend'} side
 * @param {string} [cwd]
 */
function getFrameworkDefaults(framework, side, cwd = process.cwd()) {
  if (framework === 'other') {
    return side === 'frontend'
      ? getFrontendInfo('vanilla', cwd)
      : getBackendInfo('express', cwd);
  }
  return side === 'frontend'
    ? getFrontendInfo(framework, cwd)
    : getBackendInfo(framework, cwd);
}

/**
 * @param {'frontend'|'backend'} side
 * @param {string|null} detectedFramework
 */
async function promptFramework(side, detectedFramework) {
  const choices = side === 'frontend' ? FRONTEND_CHOICES : BACKEND_CHOICES;
  const detected = detectedFramework && choices.some((c) => c.value === detectedFramework)
    ? detectedFramework
    : choices[0].value;

  const { framework } = await inquirer.prompt([
    {
      type: 'list',
      name: 'framework',
      message:
        side === 'frontend'
          ? 'Select your framework:'
          : 'Select your language / framework:',
      choices,
      default: detected,
    },
  ]);

  return framework;
}

/**
 * @param {ReturnType<typeof getFrameworkDefaults>} defaults
 * @param {'frontend'|'backend'} side
 */
async function promptBuildSettings(defaults, side) {
  const questions = [];

  if (side === 'frontend' || defaults.buildCommand) {
    questions.push({
      type: 'input',
      name: 'buildCommand',
      message: 'Build command:',
      default: defaults.buildCommand || 'npm run build',
      when: () => side === 'frontend' || defaults.buildCommand,
    });
  }

  questions.push({
    type: 'input',
    name: 'buildOutput',
    message: 'Build output directory:',
    default: defaults.buildOutput,
  });

  if (side === 'backend') {
    questions.push({
      type: 'input',
      name: 'startCommand',
      message: 'Start command:',
      default: defaults.startCommand || 'npm start',
    });
    questions.push({
      type: 'number',
      name: 'port',
      message: 'Default port:',
      default: defaults.port || 3000,
    });
  }

  return inquirer.prompt(questions);
}

const SERVER_DEPLOY_TYPES = [
  'ssh',
  'docker',
  'ec2',
  'azure-vm',
  'gcp-vm',
  'kubernetes',
];

/**
 * @param {string} projectName
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {Record<string, unknown>|null} backendConfig
 * @param {Record<string, unknown>|null} singleConfig
 */
async function promptServerDeployment(projectName, projectType, backendConfig, singleConfig) {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'deployType',
      message: 'Deployment type:',
      choices: SERVER_DEPLOY_TYPES,
    },
    {
      type: 'input',
      name: 'envName',
      message: 'Environment name:',
      default: 'production',
    },
    {
      type: 'input',
      name: 'host',
      message: 'Host (for SSH-based targets):',
      when: (a) => ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType),
    },
    {
      type: 'input',
      name: 'user',
      message: 'SSH user:',
      when: (a) => ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType),
    },
    {
      type: 'input',
      name: 'deployPath',
      message: 'Deploy path:',
      default: `/var/www/${projectName}`,
      when: (a) =>
        ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType) &&
        projectType !== 'both',
    },
    {
      type: 'input',
      name: 'frontendDeployPath',
      message: 'Frontend deploy path:',
      default: `/var/www/${projectName}/public`,
      when: (a) =>
        ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType) &&
        projectType === 'both',
    },
    {
      type: 'input',
      name: 'backendDeployPath',
      message: 'Backend deploy path:',
      default: `/var/www/${projectName}/api`,
      when: (a) =>
        ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType) &&
        projectType === 'both',
    },
    {
      type: 'input',
      name: 'appName',
      message: 'App name (for PM2):',
      default: projectType === 'both' ? `${projectName}-api` : projectName,
      when: (a) =>
        ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType) &&
        (projectType === 'backend' || projectType === 'both'),
    },
    {
      type: 'input',
      name: 'healthUrl',
      message: 'Health check URL (optional):',
    },
  ]);
}

/**
 * @param {Awaited<ReturnType<typeof promptServerDeployment>>} deployAnswers
 * @param {'frontend'|'backend'|'both'} projectType
 * @param {string} projectName
 * @param {Record<string, unknown>|null} backendConfig
 * @param {Record<string, unknown>|null} singleConfig
 */
function buildServerEnvEntry(
  deployAnswers,
  projectType,
  projectName,
  backendConfig,
  singleConfig
) {
  /** @type {Record<string, unknown>} */
  const envEntry = {
    deploymentType: 'server',
    type: deployAnswers.deployType,
    host: deployAnswers.host || '',
    user: deployAnswers.user || '',
  };

  if (projectType === 'both') {
    envEntry.frontendDeployPath =
      deployAnswers.frontendDeployPath || `/var/www/${projectName}/public`;
    envEntry.backendDeployPath =
      deployAnswers.backendDeployPath || `/var/www/${projectName}/api`;
    envEntry.appName = deployAnswers.appName || `${projectName}-api`;
    envEntry.framework = backendConfig?.framework || 'express';
    envEntry.path = envEntry.backendDeployPath;
    envEntry.backendDeploymentType = 'server';
  } else if (projectType === 'backend') {
    envEntry.deployPath = deployAnswers.deployPath || `/var/www/${projectName}`;
    envEntry.path = envEntry.deployPath;
    envEntry.appName = deployAnswers.appName || projectName;
    envEntry.framework = singleConfig?.framework || 'express';
    envEntry.port = singleConfig?.port || 3000;
  } else {
    envEntry.deployPath = deployAnswers.deployPath || `/var/www/${projectName}`;
    envEntry.path = envEntry.deployPath;
  }

  return envEntry;
}

/**
 * @param {Record<string, unknown>} config
 * @param {Record<string, Record<string, unknown>>} environments
 * @param {string} cwd
 */
async function generateProjectScaffold(config, environments, cwd) {
  const envList = Object.values(environments);

  const usesFirebase = envList.some(
    (env) =>
      env.platform === 'firebase-hosting' || env.platform === 'firebase-app-hosting'
  );

  if (usesFirebase && !(await fs.pathExists(path.join(cwd, 'firebase.json')))) {
    const buildOutput =
      config.frontend?.buildOutput || config.buildOutput || 'dist';
    await ensureFirebaseJson(buildOutput, cwd);
    console.log(chalk.gray('  • firebase.json (auto-generated)'));
  }

  const usesFrontendSsh = envList.some((env) => {
    if (env.frontendDeploymentType === 'platform') return false;
    if (env.deploymentType === 'platform' && !env.type) return false;
    return env.type === 'ssh' || env.deploymentType === 'server';
  });

  const isFrontendProject =
    config.projectType === 'frontend' || config.projectType === 'both';

  if (
    isFrontendProject &&
    usesFrontendSsh &&
    !(await fs.pathExists(path.join(cwd, 'nginx.conf')))
  ) {
    const deployPath =
      envList.find((e) => e.deployPath || e.path)?.deployPath ||
      envList.find((e) => e.deployPath || e.path)?.path ||
      `/var/www/${config.project}`;
    const buildOutput =
      config.frontend?.buildOutput || config.buildOutput || 'dist';
    const nginxConf = generateNginxConfig(config.project, deployPath, buildOutput);
    await fs.writeFile(path.join(cwd, 'nginx.conf'), nginxConf);
    console.log(chalk.gray('  • nginx.conf (auto-generated)'));
  }
}

/**
 * @param {import('commander').Command} program
 */
export function registerInitCommand(program) {
  program
    .command('init')
    .description('Interactive setup for DeployHub')
    .action(async () => {
      const cwd = process.cwd();

      if (await fs.pathExists(path.join(cwd, 'deployhub.config.json'))) {
        const { overwrite } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'overwrite',
            message: 'deployhub.config.json already exists. Overwrite?',
            default: false,
          },
        ]);
        if (!overwrite) {
          console.log(chalk.yellow('Init cancelled.'));
          return;
        }
      }

      const detectedFrontend = detectFrontend(cwd);
      const detectedBackend = detectBackend(cwd);
      const defaultName = path.basename(cwd) || 'my-app';
      const defaultCliRepo = await guessCliGithubRepo(cwd);

      const { projectName } = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectName',
          message: 'Project name:',
          default: defaultName,
        },
      ]);

      const { projectType } = await inquirer.prompt([
        {
          type: 'list',
          name: 'projectType',
          message: 'What are you deploying?',
          choices: PROJECT_TYPE_CHOICES,
          default: detectedFrontend && detectedBackend
            ? 'both'
            : detectedBackend
              ? 'backend'
              : 'frontend',
        },
      ]);

      /** @type {Record<string, unknown>} */
      let frontendConfig = null;
      /** @type {Record<string, unknown>} */
      let backendConfig = null;
      /** @type {Record<string, unknown>} */
      let singleConfig = null;

      if (projectType === 'frontend' || projectType === 'both') {
        const fw = await promptFramework('frontend', detectedFrontend?.framework || null);
        const defaults = getFrameworkDefaults(fw, 'frontend', cwd);
        const settings = await promptBuildSettings(defaults, 'frontend');
        frontendConfig = {
          framework: fw === 'other' ? 'custom' : fw,
          buildCommand: settings.buildCommand ?? defaults.buildCommand,
          buildOutput: settings.buildOutput || defaults.buildOutput,
        };
      }

      if (projectType === 'backend' || projectType === 'both') {
        const fw = await promptFramework('backend', detectedBackend?.framework || null);
        const defaults = getFrameworkDefaults(fw, 'backend', cwd);
        const settings = await promptBuildSettings(defaults, 'backend');
        backendConfig = {
          framework: fw === 'other' ? 'custom' : fw,
          language: defaults.language,
          buildCommand: settings.buildCommand ?? defaults.buildCommand ?? null,
          startCommand: settings.startCommand ?? defaults.startCommand,
          buildOutput: settings.buildOutput || defaults.buildOutput,
          port: settings.port ?? defaults.port,
        };
      }

      if (projectType === 'frontend') {
        singleConfig = { ...frontendConfig };
      } else if (projectType === 'backend') {
        singleConfig = { ...backendConfig };
      }

      const answers = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'storage',
          message: 'Select storage providers:',
          choices: [
            { name: 'Local', value: 'local', checked: true },
            { name: 'AWS S3', value: 'aws' },
            { name: 'Google Drive', value: 'gdrive' },
            { name: 'Azure Blob', value: 'azure' },
            { name: 'GCP Storage', value: 'gcp' },
            { name: 'Dropbox', value: 'dropbox' },
          ],
        },
        {
          type: 'confirm',
          name: 'configureDeploy',
          message: 'Configure deployment?',
          default: false,
        },
        {
          type: 'input',
          name: 'cliSource',
          message:
            'DeployHub CLI source for GitHub Actions (github:user/repo or npm:@akash-chowdhury-24/deployhub):',
          default: defaultCliRepo,
        },
      ]);

      /** @type {Record<string, Record<string, unknown>>} */
      const environments = {};
      /** @type {string[]} */
      const deploy = [];
      let healthUrl = '';

      if (answers.configureDeploy) {
        const buildOutput =
          frontendConfig?.buildOutput || singleConfig?.buildOutput || 'dist';

        if (projectType === 'backend') {
          const deployAnswers = await promptServerDeployment(
            projectName,
            projectType,
            backendConfig,
            singleConfig
          );
          deploy.push(deployAnswers.envName);
          environments[deployAnswers.envName] = buildServerEnvEntry(
            deployAnswers,
            projectType,
            projectName,
            backendConfig,
            singleConfig
          );
          if (deployAnswers.healthUrl) {
            healthUrl = deployAnswers.healthUrl;
          } else if (singleConfig?.port) {
            healthUrl = `http://localhost:${singleConfig.port}/health`;
          }
        } else if (projectType === 'frontend') {
          const { deployMethod } = await inquirer.prompt([
            {
              type: 'list',
              name: 'deployMethod',
              message: 'How do you want to deploy?',
              choices: [
                {
                  name: 'Managed platform (Vercel, Netlify, Cloudflare Pages, etc.)',
                  value: 'platform',
                },
                {
                  name: 'Self-hosted server (SSH, Docker, EC2, etc.)',
                  value: 'server',
                },
              ],
            },
          ]);

          const { envName } = await inquirer.prompt([
            {
              type: 'input',
              name: 'envName',
              message: 'Environment name:',
              default: 'production',
            },
          ]);
          deploy.push(envName);

          if (deployMethod === 'platform') {
            showPlatformComparison();
            const { platform } = await inquirer.prompt([
              {
                type: 'list',
                name: 'platform',
                message: 'Select platform:',
                choices: PLATFORM_CHOICES,
              },
            ]);

            const platformConfig = await promptPlatformQuestions(
              platform,
              projectName,
              buildOutput,
              cwd
            );
            await appendPlatformEnvExample(platform, cwd);

            const { healthUrlInput } = await inquirer.prompt([
              {
                type: 'input',
                name: 'healthUrlInput',
                message: 'Health check URL (optional):',
                default: suggestHealthUrl(platform, projectName),
              },
            ]);

            environments[envName] = {
              deploymentType: 'platform',
              ...platformConfig,
            };
            healthUrl = healthUrlInput || suggestHealthUrl(platform, projectName);
          } else {
            const deployAnswers = await promptServerDeployment(
              projectName,
              projectType,
              backendConfig,
              singleConfig
            );
            deployAnswers.envName = envName;
            environments[envName] = buildServerEnvEntry(
              deployAnswers,
              projectType,
              projectName,
              backendConfig,
              singleConfig
            );
            if (deployAnswers.healthUrl) healthUrl = deployAnswers.healthUrl;
          }
        } else {
          const { frontendDeployMethod } = await inquirer.prompt([
            {
              type: 'list',
              name: 'frontendDeployMethod',
              message: 'How do you want to deploy the frontend?',
              choices: [
                {
                  name: 'Managed platform (Vercel, Netlify, Cloudflare Pages, etc.)',
                  value: 'platform',
                },
                {
                  name: 'Self-hosted server (SSH, Docker, EC2, etc.)',
                  value: 'server',
                },
              ],
            },
          ]);

          const { envName } = await inquirer.prompt([
            {
              type: 'input',
              name: 'envName',
              message: 'Environment name:',
              default: 'production',
            },
          ]);
          deploy.push(envName);

          /** @type {Record<string, unknown>} */
          const envEntry = { backendDeploymentType: 'server' };

          if (frontendDeployMethod === 'platform') {
            showPlatformComparison();
            const { platform } = await inquirer.prompt([
              {
                type: 'list',
                name: 'platform',
                message: 'Select frontend platform:',
                choices: PLATFORM_CHOICES,
              },
            ]);

            const platformConfig = await promptPlatformQuestions(
              platform,
              projectName,
              buildOutput,
              cwd
            );
            await appendPlatformEnvExample(platform, cwd);

            Object.assign(envEntry, {
              frontendDeploymentType: 'platform',
              deploymentType: 'platform',
              ...platformConfig,
            });
            healthUrl = suggestHealthUrl(platform, projectName);
          } else {
            envEntry.frontendDeploymentType = 'server';
          }

          console.log(chalk.gray('\nBackend will be deployed to a self-hosted server.'));
          const backendDeployAnswers = await inquirer.prompt([
            {
              type: 'list',
              name: 'deployType',
              message: 'Backend deployment type:',
              choices: SERVER_DEPLOY_TYPES,
              default: 'ssh',
            },
            {
              type: 'input',
              name: 'host',
              message: 'Host (for SSH-based targets):',
              when: (a) => ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType),
            },
            {
              type: 'input',
              name: 'user',
              message: 'SSH user:',
              when: (a) => ['ssh', 'ec2', 'azure-vm', 'gcp-vm'].includes(a.deployType),
            },
            {
              type: 'input',
              name: 'backendDeployPath',
              message: 'Backend deploy path:',
              default: `/var/www/${projectName}/api`,
            },
            {
              type: 'input',
              name: 'appName',
              message: 'App name (for PM2):',
              default: `${projectName}-api`,
            },
          ]);

          Object.assign(envEntry, {
            type: backendDeployAnswers.deployType,
            host: backendDeployAnswers.host || '',
            user: backendDeployAnswers.user || '',
            backendDeployPath:
              backendDeployAnswers.backendDeployPath || `/var/www/${projectName}/api`,
            appName: backendDeployAnswers.appName || `${projectName}-api`,
            framework: backendConfig?.framework || 'express',
            path: backendDeployAnswers.backendDeployPath || `/var/www/${projectName}/api`,
          });

          if (frontendDeployMethod === 'server') {
            const { frontendDeployPath } = await inquirer.prompt([
              {
                type: 'input',
                name: 'frontendDeployPath',
                message: 'Frontend deploy path:',
                default: `/var/www/${projectName}/public`,
              },
            ]);
            envEntry.frontendDeployPath = frontendDeployPath;
          }

          const { healthUrlInput } = await inquirer.prompt([
            {
              type: 'input',
              name: 'healthUrlInput',
              message: 'Health check URL (optional):',
              default: healthUrl || '',
            },
          ]);
          if (healthUrlInput) healthUrl = healthUrlInput;
          else if (!healthUrl && backendConfig?.port) {
            healthUrl = `http://localhost:${backendConfig.port}/health`;
          }

          environments[envName] = envEntry;
        }
      }

      const version = await getProjectVersion(cwd);
      const hasDocker =
        (detectedFrontend?.hasDocker || detectedBackend?.hasDocker) ?? false;

      /** @type {Record<string, unknown>} */
      const config = {
        project: projectName,
        version,
        projectType,
        artifact: true,
        storage: answers.storage.length > 0 ? answers.storage : ['local'],
        deploy,
        environments,
        healthCheck: {
          url: healthUrl,
          timeout: 30,
        },
        notifications: {
          slack: false,
          email: false,
          webhook: false,
        },
        pipeline: {
          test: true,
          docker: hasDocker,
          deploy: deploy.length > 0,
          verify: !!healthUrl,
          notify: false,
        },
        artifactRetention: 10,
        cli: {
          source: answers.cliSource,
        },
      };

      if (projectType === 'both') {
        config.frontend = frontendConfig;
        config.backend = backendConfig;
        config.framework = backendConfig?.framework;
      } else {
        Object.assign(config, singleConfig);
        if (projectType === 'backend') {
          config.docker = hasDocker;
        } else {
          config.docker = hasDocker;
        }
      }

      await saveConfig(config, cwd);
      await addDeployhubToPackageJson(answers.cliSource, cwd);
      await writeWorkflowFile(
        config.storage,
        deploy,
        environments,
        cwd,
        answers.cliSource,
        config
      );

      await generateProjectScaffold(config, environments, cwd);

      const envExampleDest = path.join(cwd, '.env.example');
      const envExampleContent = generateEnvExampleContent(
        config.storage,
        deploy,
        environments,
        config
      );
      await fs.writeFile(envExampleDest, envExampleContent);

      const secrets = getRequiredSecrets(config.storage, deploy, environments, config);

      console.log('');
      console.log(chalk.green.bold('✓ DeployHub initialized successfully!'));
      console.log('');
      console.log(chalk.bold('Generated files:'));
      console.log('  • deployhub.config.json');
      console.log('  • .github/workflows/deployhub.yml');
      console.log('  • .env.example');
      console.log('');
      console.log(chalk.bold('Next steps:'));
      console.log('  1. Push the DeployHub CLI repo to GitHub (if using github: source)');
      console.log('  2. Copy .env.example to .env and fill in credentials');
      if (secrets.length > 0) {
        console.log('  3. Add these secrets to GitHub (Settings → Secrets):');
        secrets.forEach((s) => console.log(`     • ${s}`));
      }
      console.log(`  ${secrets.length > 0 ? '4' : '3'}. Run ${chalk.cyan('deployhub doctor')} to verify your setup`);
      console.log(`  ${secrets.length > 0 ? '5' : '4'}. Push to main — GitHub Actions will run ${chalk.cyan('deployhub build')} automatically`);
      console.log('');
      printAuthorFooter();
    });
}

export default { registerInitCommand };
