import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { saveConfig, appendEnv } from '../core/config.js';
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
  addDeployhubToPackageJson,
  DEFAULT_NPM_CLI_SOURCE,
} from '../utils/github-actions.js';
import { printAuthorFooter } from '../utils/author.js';
import { generateNginxConfig } from '../utils/nginx.js';
import {
  ensureDockerfile,
  ensureKubernetesManifests,
} from '../utils/scaffold.js';
import {
  promptServerDeployment,
  buildServerEnvEntry,
  getDockerEnvSecrets,
  SSH_BASED,
} from '../deployment/init-prompts.js';
import { printDeploymentNextSteps } from '../deployment/deployment-env.js';
import { confirmValueIfContainsSpaces } from '../deployment/init-helpers.js';

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

/**
 * @param {Record<string, unknown>} config
 * @param {Record<string, Record<string, unknown>>} environments
 * @param {string} cwd
 */
async function generateProjectScaffold(config, environments, cwd) {
  const envList = Object.values(environments);

  const usesFrontendSsh = envList.some(
    (env) =>
      SSH_BASED.includes(env.type) || env.deploymentType === 'server'
  );

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

  const dockerResult = await ensureDockerfile(cwd, config);
  if (dockerResult.generated) {
    console.log(chalk.gray('  • Dockerfile (auto-generated)'));
  }

  const k8sResult = await ensureKubernetesManifests(cwd, config, environments);
  if (k8sResult.generated) {
    console.log(chalk.gray('  • k8s/deployment.yaml, k8s/service.yaml (auto-generated)'));
  }

  return {
    dockerfileGenerated: dockerResult.generated,
    kubernetesGenerated: k8sResult.generated,
  };
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
      const cliSource = DEFAULT_NPM_CLI_SOURCE;

      let { projectName } = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectName',
          message: 'Project name:',
          default: defaultName,
        },
      ]);

      projectName = await confirmValueIfContainsSpaces(projectName, 'project name');

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
      ]);

      /** @type {Record<string, Record<string, unknown>>} */
      const environments = {};
      /** @type {string[]} */
      const deploy = [];
      let healthUrl = '';
      /** @type {string|undefined} */
      let primaryDeployType;
      /** @type {Record<string, string>|null} */
      let dockerEnvToAppend = null;

      if (answers.configureDeploy) {
        if (projectType === 'backend') {
          const deployAnswers = await promptServerDeployment(
            projectName,
            projectType,
            backendConfig
          );
          primaryDeployType = deployAnswers.deployType;
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
          dockerEnvToAppend = getDockerEnvSecrets(deployAnswers);
        } else if (projectType === 'frontend') {
          const deployAnswers = await promptServerDeployment(
            projectName,
            projectType,
            backendConfig
          );
          primaryDeployType = deployAnswers.deployType;
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
          }
          dockerEnvToAppend = getDockerEnvSecrets(deployAnswers);
        } else {
          const backendDeployAnswers = await promptServerDeployment(
            projectName,
            'both',
            backendConfig
          );
          primaryDeployType = backendDeployAnswers.deployType;
          deploy.push(backendDeployAnswers.envName);

          /** @type {Record<string, unknown>} */
          const envEntry = {
            backendDeploymentType: 'server',
            frontendDeploymentType: 'server',
            deploymentType: 'server',
          };

          Object.assign(
            envEntry,
            buildServerEnvEntry(
              backendDeployAnswers,
              'both',
              projectName,
              backendConfig,
              singleConfig
            )
          );

          if (backendDeployAnswers.healthUrl) {
            healthUrl = backendDeployAnswers.healthUrl;
          } else if (backendConfig?.port) {
            healthUrl = `http://localhost:${backendConfig.port}/health`;
          }

          environments[backendDeployAnswers.envName] = envEntry;
          dockerEnvToAppend = getDockerEnvSecrets(backendDeployAnswers);
        }
      }

      const version = await getProjectVersion(cwd);
      let hasDocker =
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
          source: cliSource,
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
      if (dockerEnvToAppend) {
        await appendEnv(dockerEnvToAppend, cwd);
      }
      await addDeployhubToPackageJson(cliSource, cwd);
      await writeWorkflowFile(
        config.storage,
        deploy,
        environments,
        cwd,
        cliSource,
        config
      );

      const scaffoldResult = await generateProjectScaffold(config, environments, cwd);

      if (scaffoldResult?.dockerfileGenerated) {
        hasDocker = true;
        config.docker = true;
        config.pipeline.docker = true;
        await saveConfig(config, cwd);
      }

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
      if (primaryDeployType) {
        console.log(chalk.green.bold(`✔ Config generated for ${primaryDeployType} deployment.`));
        printDeploymentNextSteps(primaryDeployType, secrets);
      } else {
        console.log(chalk.green.bold('✓ DeployHub initialized successfully!'));
        console.log('');
        console.log(chalk.bold('Next steps:'));
        console.log('  1. Copy .env.example to .env and fill in credentials');
        if (secrets.length > 0) {
          console.log('  2. Add these secrets to GitHub (Settings → Secrets):');
          secrets.forEach((s) => console.log(`     • ${s}`));
        }
        console.log(`  ${secrets.length > 0 ? '3' : '2'}. Run ${chalk.cyan('deployhub doctor')} to verify your setup`);
        console.log(`  ${secrets.length > 0 ? '4' : '3'}. Push to main — GitHub Actions will run ${chalk.cyan('deployhub build')} automatically`);
      }

      console.log('');
      console.log(chalk.bold('Generated files:'));
      console.log('  • deployhub.config.json');
      console.log('  • .github/workflows/deployhub.yml');
      console.log('  • .env.example');
      console.log('');
      printAuthorFooter();
    });
}

export default { registerInitCommand };
