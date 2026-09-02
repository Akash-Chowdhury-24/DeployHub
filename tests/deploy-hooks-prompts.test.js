/**
 * Init / env-add hook prompts: optional, SSH-based + docker-ssh only.
 */
import { jest } from '@jest/globals';

/** @type {{ name?: string, message?: string, default?: unknown, type?: string }[]} */
const prompted = [];
/** @type {Record<string, unknown>} */
let answersOverride = {};

jest.unstable_mockModule('inquirer', () => ({
  default: {
    prompt: async (questions) => {
      const list = Array.isArray(questions) ? questions : [questions];
      prompted.push(...list);
      /** @type {Record<string, unknown>} */
      const answers = {};
      for (const q of list) {
        if (Object.prototype.hasOwnProperty.call(answersOverride, q.name)) {
          answers[q.name] = answersOverride[q.name];
        } else {
          answers[q.name] = q.default ?? (q.type === 'confirm' ? false : '');
        }
      }
      return answers;
    },
  },
}));

const { promptDeployHooks, promptServerDeployment, buildServerEnvEntry } = await import(
  '../src/deployment/init-prompts.js'
);

describe('promptDeployHooks', () => {
  beforeEach(() => {
    prompted.length = 0;
    answersOverride = {};
  });

  test('defaults skip all hooks (optional / skippable)', async () => {
    const result = await promptDeployHooks();
    expect(result).toEqual({});
    expect(prompted.map((q) => q.name)).toEqual([
      'addPreDeploy',
      'addPostDeploy',
      'addRollback',
    ]);
    expect(prompted.find((q) => q.name === 'addPreDeploy').default).toBe(false);
  });
});

describe('promptDeployHooks sequential answers', () => {
  beforeEach(() => {
    prompted.length = 0;
  });

  test('records continueOnError defaults per hook type', async () => {
    const queue = [
      { addPreDeploy: true },
      { command: 'docker exec myapp python manage.py migrate', abortOnFailure: true },
      { addPostDeploy: true },
      { command: "curl -s https://example.com/hook -d deployed", abortOnFailure: false },
      { addRollback: true },
      { command: 'docker exec myapp python manage.py migrate zero', abortOnFailure: true },
    ];
    const inquirer = await import('inquirer');
    inquirer.default.prompt = async (questions) => {
      const list = Array.isArray(questions) ? questions : [questions];
      prompted.push(...list);
      return queue.shift() || {};
    };

    const result = await promptDeployHooks();
    expect(result.hooks.preDeploy[0]).toEqual({
      command: 'docker exec myapp python manage.py migrate',
      continueOnError: false,
    });
    expect(result.hooks.postDeploy[0]).toEqual({
      command: 'curl -s https://example.com/hook -d deployed',
      continueOnError: true,
    });
    expect(result.hooks.rollback[0]).toEqual({
      command: 'docker exec myapp python manage.py migrate zero',
      continueOnError: false,
    });
  });
});

describe('docker local init does not ask for hooks', () => {
  beforeEach(() => {
    prompted.length = 0;
  });

  test('promptServerDeployment docker local never asks hook confirms', async () => {
    const answers = await promptServerDeployment('demo-app', 'frontend', null, {
      envName: 'staging',
      deployType: 'docker',
      portDefault: 3000,
    });
    expect(prompted.find((q) => q.name === 'addPreDeploy')).toBeUndefined();
    expect(answers.hooks).toBeUndefined();
    const entry = buildServerEnvEntry(answers, 'frontend', 'demo-app', null, {
      port: 3000,
    });
    expect(entry.config.hooks).toBeUndefined();
  });
});
