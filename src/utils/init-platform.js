import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import {
  PLATFORM_CHOICES,
  PLATFORM_COMPARISON,
  getPlatformEnvExample,
} from './platform-env.js';
import { ensureFirebaseJson } from './firebase-config-generator.js';
import { appendEnv } from '../core/config.js';

/**
 * @param {string} platform
 * @param {string} projectName
 * @param {string} buildOutput
 * @param {string} [cwd]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function promptPlatformQuestions(
  platform,
  projectName,
  buildOutput,
  cwd = process.cwd()
) {
  /** @type {Record<string, unknown>} */
  const config = { platform };

  switch (platform) {
    case 'vercel': {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectName',
          message: 'Vercel project name:',
          default: projectName,
        },
        {
          type: 'confirm',
          name: 'vercelLinked',
          message: 'Have you already linked this project with Vercel?',
          default: fs.existsSync(path.join(cwd, '.vercel', 'project.json')),
        },
      ]);
      config.projectName = answers.projectName;

      if (!answers.vercelLinked) {
        console.log(chalk.gray('Running vercel link — follow the prompts...'));
        try {
          await execa('vercel', ['link'], { cwd, stdio: 'inherit' });
        } catch {
          console.log(
            chalk.yellow(
              'Could not run vercel link automatically. Run it manually, then add VERCEL_ORG_ID and VERCEL_PROJECT_ID to .env'
            )
          );
        }
      }
      break;
    }

    case 'netlify': {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'siteId',
          message: 'Netlify site ID (from Netlify dashboard):',
        },
      ]);
      config.siteId = answers.siteId;
      break;
    }

    case 'cloudflare-pages': {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectName',
          message: 'Cloudflare Pages project name:',
          default: projectName,
        },
        {
          type: 'input',
          name: 'accountId',
          message: 'Cloudflare account ID (from dashboard):',
        },
      ]);
      config.projectName = answers.projectName;
      config.accountId = answers.accountId;
      break;
    }

    case 'aws-amplify': {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'appId',
          message: 'Amplify App ID (from AWS console):',
        },
        {
          type: 'input',
          name: 'region',
          message: 'AWS region:',
          default: 'us-east-1',
        },
        {
          type: 'confirm',
          name: 'githubConnected',
          message: 'GitHub already connected to Amplify?',
          default: true,
        },
      ]);
      config.appId = answers.appId;
      config.region = answers.region;
      config.githubConnected = answers.githubConnected;
      break;
    }

    case 'azure-static-web-apps': {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'resourceName',
          message: 'Resource name:',
          default: projectName,
        },
      ]);
      config.resourceName = answers.resourceName;
      break;
    }

    case 'firebase-hosting': {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectId',
          message: 'Firebase project ID:',
          default: projectName,
        },
      ]);
      config.projectId = answers.projectId;
      await ensureFirebaseJson(buildOutput, cwd);
      console.log(chalk.green('✓ firebase.json generated'));
      break;
    }

    case 'firebase-app-hosting': {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'projectId',
          message: 'Firebase project ID:',
          default: projectName,
        },
        {
          type: 'input',
          name: 'backendName',
          message: 'Backend name:',
          default: `${projectName}-backend`,
        },
      ]);
      config.projectId = answers.projectId;
      config.backendName = answers.backendName;
      break;
    }

    default:
      break;
  }

  return config;
}

/**
 * @param {string} platform
 * @param {string} [cwd]
 */
export async function appendPlatformEnvExample(platform, cwd = process.cwd()) {
  const examples = getPlatformEnvExample(platform);
  await appendEnv(examples, cwd);

  const envExamplePath = path.join(cwd, '.env.example');
  if (!(await fs.pathExists(envExamplePath))) return;

  let content = await fs.readFile(envExamplePath, 'utf-8');
  const sectionHeader = `\n# ${platform} deployment\n`;
  const lines = Object.keys(examples)
    .map((key) => `${key}=`)
    .join('\n');

  if (!content.includes(`${platform} deployment`)) {
    content += `${sectionHeader}${lines}\n`;
    await fs.writeFile(envExamplePath, content);
  }
}

export function showPlatformComparison() {
  console.log('');
  console.log(chalk.bold('Platform comparison:'));
  console.log(chalk.gray(PLATFORM_COMPARISON));
  console.log('');
}

/**
 * @param {string} platform
 * @param {string} projectName
 * @returns {string}
 */
export function suggestHealthUrl(platform, projectName) {
  const urls = {
    vercel: `https://${projectName}.vercel.app`,
    netlify: `https://${projectName}.netlify.app`,
    'cloudflare-pages': `https://${projectName}.pages.dev`,
    'firebase-hosting': `https://${projectName}.web.app`,
    'firebase-app-hosting': `https://${projectName}.web.app`,
  };
  return urls[platform] || '';
}

export { PLATFORM_CHOICES };

export default {
  promptPlatformQuestions,
  appendPlatformEnvExample,
  showPlatformComparison,
  suggestHealthUrl,
  PLATFORM_CHOICES,
};
