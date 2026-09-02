/**
 * env add / init docker flow must ask Default port and persist it on the
 * environment config — the same key resolveDockerPublishPort reads.
 */
import { jest } from '@jest/globals';

/** @type {{ name?: string, message?: string, default?: unknown }[]} */
const prompted = [];

jest.unstable_mockModule('inquirer', () => ({
  default: {
    prompt: async (questions) => {
      const list = Array.isArray(questions) ? questions : [questions];
      prompted.push(...list);
      /** @type {Record<string, unknown>} */
      const answers = {};
      for (const q of list) {
        if (q.name === 'remoteMode') answers.remoteMode = 'local';
        else if (q.name === 'port') answers.port = q.default;
        else answers[q.name] = q.default ?? '';
      }
      return answers;
    },
  },
}));

const { promptServerDeployment, buildServerEnvEntry } = await import(
  '../src/deployment/init-prompts.js'
);

describe('env add docker Default port prompt', () => {
  beforeEach(() => {
    prompted.length = 0;
  });

  test('asks Default port and stores it on environments.<env>.config.port', async () => {
    const answers = await promptServerDeployment('demo-app', 'backend', { port: 8000 }, {
      envName: 'staging',
      deployType: 'docker',
      portDefault: 8000,
    });

    const portQ = prompted.find((q) => q.name === 'port');
    expect(portQ).toBeTruthy();
    expect(portQ.message).toBe('Default port:');
    expect(portQ.default).toBe(8000);
    expect(answers.port).toBe(8000);

    const triggerQ = prompted.find((q) => q.name === 'trigger');
    expect(triggerQ).toBeTruthy();
    expect(triggerQ.message).toMatch(/When should this environment deploy/);
    expect(answers.trigger).toBe('manual');
    expect(answers.branch).toBeUndefined();

    const entry = buildServerEnvEntry(
      answers,
      'backend',
      'demo-app',
      { port: 8000 },
      { framework: 'fastapi', port: answers.port }
    );
    expect(entry.method).toBe('docker');
    expect(entry.config.port).toBe(8000);
    expect(entry.trigger).toBe('manual');
    expect(entry.branch).toBeUndefined();
    expect(prompted.find((q) => q.name === 'addPreDeploy')).toBeUndefined();
    expect(prompted.find((q) => q.name === 'addPostDeploy')).toBeUndefined();
    expect(prompted.find((q) => q.name === 'addRollback')).toBeUndefined();
  });

  test('defaultTrigger push asks which branch triggers this environment', async () => {
    const answers = await promptServerDeployment('demo-app', 'frontend', null, {
      envName: 'production',
      deployType: 'docker',
      defaultTrigger: 'push',
      defaultBranch: 'main',
    });
    const branchQ = prompted.find((q) => q.name === 'branch');
    expect(branchQ).toBeTruthy();
    expect(branchQ.message).toBe('Which branch triggers this environment?');
    expect(branchQ.default).toBe('main');
    expect(answers.trigger).toBe('push');
    expect(answers.branch).toBe('main');

    const entry = buildServerEnvEntry(answers, 'frontend', 'demo-app', null, {
      framework: 'react',
    });
    expect(entry.trigger).toBe('push');
    expect(entry.branch).toBe('main');
  });
});
