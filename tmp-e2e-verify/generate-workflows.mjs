/**
 * Real sync-workflows path: writeWorkflowFile + getEnabledEnvironmentNames
 * Generates deployhub.yml + deployhub-rollback.yml for four configs.
 */
import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { writeWorkflowFile } from '../src/utils/github-actions.js';
import { getEnabledEnvironmentNames } from '../src/core/environments.js';
import { pipelineDeployTargets } from '../src/core/stages.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'configs');

const CLI = 'npm:@akash-chowdhury-24/deployhub';

/** @type {Record<string, object>} */
const CONFIGS = {
  '1-single-ec2-push': {
    project: 'demo-single',
    projectType: 'frontend',
    framework: 'react',
    version: '1.0.0',
    defaultEnvironment: 'production',
    unprefixedSecretEnvironment: 'production',
    storage: ['local'],
    pipeline: { deploy: true, notify: false },
    environments: {
      production: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: {
          host: 'prod.example.com',
          user: 'ubuntu',
          deployPath: '/var/www/app',
        },
      },
    },
  },
  '2-two-ec2-both-push': {
    project: 'demo-two-ec2',
    projectType: 'frontend',
    framework: 'react',
    version: '1.0.0',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    storage: ['aws'],
    pipeline: { deploy: true, notify: false },
    environments: {
      development: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: {
          host: 'dev.example.com',
          user: 'ubuntu',
          deployPath: '/var/www/dev',
        },
      },
      production: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: {
          host: 'prod.example.com',
          user: 'ubuntu',
          deployPath: '/var/www/prod',
        },
      },
    },
  },
  '3-mixed-trigger': {
    project: 'demo-mixed',
    projectType: 'frontend',
    framework: 'react',
    version: '1.0.0',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    storage: ['aws'],
    pipeline: { deploy: true, notify: false },
    environments: {
      development: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: {
          host: 'dev.example.com',
          user: 'ubuntu',
          deployPath: '/var/www/dev',
        },
      },
      production: {
        enabled: true,
        method: 'ec2',
        trigger: 'manual',
        config: {
          host: 'prod.example.com',
          user: 'ubuntu',
          deployPath: '/var/www/prod',
        },
      },
    },
  },
  '4-three-methods-all-push': {
    project: 'demo-multi-method',
    projectType: 'frontend',
    framework: 'react',
    version: '1.0.0',
    defaultEnvironment: 'development',
    unprefixedSecretEnvironment: 'development',
    storage: ['aws'],
    pipeline: { deploy: true, notify: false },
    environments: {
      development: {
        enabled: true,
        method: 'ec2',
        trigger: 'push',
        config: {
          host: 'dev.example.com',
          user: 'ubuntu',
          deployPath: '/var/www/dev',
        },
      },
      staging: {
        enabled: true,
        method: 'docker',
        trigger: 'push',
        config: {
          dockerImageName: 'org/staging-app',
        },
      },
      production: {
        enabled: true,
        method: 'kubernetes',
        trigger: 'push',
        config: {
          kubeNamespace: 'prod',
          dockerImageName: 'org/prod-app',
        },
      },
    },
  },
};

function extractNamedStepEnv(parsed, stepNameIncludes) {
  const steps = parsed?.jobs?.deploy?.steps || parsed?.jobs?.rollback?.steps || [];
  const step = steps.find((s) => String(s.name || '').includes(stepNameIncludes));
  return step?.env || null;
}

function sortedEnvKeys(envObj) {
  if (!envObj) return [];
  return Object.keys(envObj).sort();
}

function envBlockText(envObj) {
  if (!envObj) return '(missing)';
  return sortedEnvKeys(envObj)
    .map((k) => `          ${k}: ${envObj[k]}`)
    .join('\n');
}

async function generateOne(name, config) {
  const dir = path.join(OUT, name);
  await fs.emptyDir(dir);
  await fs.writeJson(path.join(dir, 'deployhub.config.json'), config, { spaces: 2 });

  // Exact sync-workflows call path
  const storage = config.storage || [];
  const environments = config.environments || {};
  const deploy = getEnabledEnvironmentNames(config);
  const cliSource = CLI;

  await writeWorkflowFile(storage, deploy, environments, dir, cliSource, config);

  const deployYml = await fs.readFile(
    path.join(dir, '.github', 'workflows', 'deployhub.yml'),
    'utf8'
  );
  const rollbackYml = await fs.readFile(
    path.join(dir, '.github', 'workflows', 'deployhub-rollback.yml'),
    'utf8'
  );

  const deployParsed = yaml.load(deployYml);
  const rollbackParsed = yaml.load(rollbackYml);

  const buildEnv = extractNamedStepEnv(deployParsed, 'Build');
  const dispatchEnv = extractNamedStepEnv(deployParsed, 'Deploy (workflow_dispatch)');
  const rollbackEnv = extractNamedStepEnv(rollbackParsed, 'Rollback');

  const buildKeys = sortedEnvKeys(buildEnv);
  const dispatchKeys = sortedEnvKeys(dispatchEnv);
  const rollbackKeys = sortedEnvKeys(rollbackEnv);

  const buildEqDispatch =
    buildKeys.length === dispatchKeys.length &&
    buildKeys.every((k, i) => k === dispatchKeys[i]) &&
    buildKeys.every((k) => buildEnv[k] === dispatchEnv[k]);

  const deploySecretKeys = buildKeys.filter((k) => k !== 'DEPLOYHUB_ENV');
  const rollbackSecretKeys = rollbackKeys.filter((k) => k !== 'DEPLOYHUB_ENV');
  const rollbackMatchesDeployScope =
    deploySecretKeys.length === rollbackSecretKeys.length &&
    deploySecretKeys.every((k, i) => k === rollbackSecretKeys[i]) &&
    deploySecretKeys.every((k) => buildEnv[k] === rollbackEnv[k]);

  const pushTargets = pipelineDeployTargets(config, {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
  });
  const dispatchTargets = pipelineDeployTargets(config, {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  });

  const report = {
    name,
    enabledEnvs: deploy,
    pushTargets,
    dispatchTargets,
    buildEqDispatch,
    rollbackMatchesDeployScope,
    buildKeys,
    dispatchKeys,
    rollbackKeys,
    buildEnvBlock: envBlockText(buildEnv),
    dispatchEnvBlock: envBlockText(dispatchEnv),
    rollbackEnvBlock: envBlockText(rollbackEnv),
  };

  await fs.writeJson(path.join(dir, '_compare.json'), report, { spaces: 2 });
  await fs.writeFile(path.join(dir, '_MANIFEST.txt'), [
    `CONFIG: ${name}`,
    `enabledEnvs: ${JSON.stringify(deploy)}`,
    `pipelineDeployTargets(push): ${JSON.stringify(pushTargets)}`,
    `pipelineDeployTargets(workflow_dispatch): ${JSON.stringify(dispatchTargets)}`,
    `Build===Dispatch secret sets: ${buildEqDispatch}`,
    `Rollback secrets match Deploy Build scope: ${rollbackMatchesDeployScope}`,
    '',
    '=== BUILD env block ===',
    envBlockText(buildEnv),
    '',
    '=== DISPATCH env block ===',
    envBlockText(dispatchEnv),
    '',
    '=== ROLLBACK env block ===',
    envBlockText(rollbackEnv),
    '',
  ].join('\n'));

  console.log(`\n########## GENERATED ${name} ##########`);
  console.log(`enabled: ${deploy.join(', ')}`);
  console.log(`push deploy targets: ${JSON.stringify(pushTargets)}`);
  console.log(`Build===Dispatch: ${buildEqDispatch}`);
  console.log(`Rollback matches Deploy secret scope: ${rollbackMatchesDeployScope}`);
  console.log(`wrote ${path.join(dir, '.github', 'workflows', 'deployhub.yml')}`);
  console.log(`wrote ${path.join(dir, '.github', 'workflows', 'deployhub-rollback.yml')}`);
}

await fs.emptyDir(OUT);
for (const [name, config] of Object.entries(CONFIGS)) {
  await generateOne(name, config);
}
console.log('\nAll four configs generated via writeWorkflowFile (sync-workflows path).');
