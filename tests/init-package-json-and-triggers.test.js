import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  addDeployhubToPackageJson,
  getCliPackageJsonDependencyVersion,
  getCliInstallSpec,
  DEFAULT_NPM_CLI_SOURCE,
} from '../src/utils/github-actions.js';
import {
  buildServerEnvEntry,
  applyInitTriggerDefaults,
  formatMultiEnvTriggerReminder,
} from '../src/deployment/init-prompts.js';

const PKG = '@akash-chowdhury-24/deployhub';

describe('addDeployhubToPackageJson dependency version', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-pkg-dep-'));
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'demo-app',
      version: '0.0.1',
    });
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('writes a semver range or "latest", never name@version as the value', async () => {
    await addDeployhubToPackageJson(DEFAULT_NPM_CLI_SOURCE, tmp);
    const pkg = await fs.readJson(path.join(tmp, 'package.json'));
    const value = pkg.devDependencies[PKG];

    expect(typeof value).toBe('string');
    expect(value).not.toContain(PKG);
    expect(value).not.toMatch(/@akash-chowdhury-24\/deployhub@/);
    // Valid: ^1.2.3 or latest
    expect(value === 'latest' || /^\^\d+\.\d+\.\d+/.test(value)).toBe(true);
  });

  test('getCliPackageJsonDependencyVersion differs from getCliInstallSpec for npm', () => {
    const installSpec = getCliInstallSpec(DEFAULT_NPM_CLI_SOURCE);
    const depValue = getCliPackageJsonDependencyVersion(DEFAULT_NPM_CLI_SOURCE);
    expect(installSpec).toBe(`${PKG}@latest`);
    expect(depValue).not.toBe(installSpec);
    expect(depValue).not.toContain(PKG);
  });

  test('github cli source keeps a valid git dependency value without double-wrapping', async () => {
    const src = 'github:Akash-Chowdhury-24/DeployHub';
    await addDeployhubToPackageJson(src, tmp);
    const pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe(src);
  });
});

describe('init trigger defaults (single vs multi)', () => {
  const baseAnswers = {
    deployType: 'ssh',
    envName: 'default',
    host: '10.0.0.1',
    user: 'deploy',
    keyPath: '~/.ssh/id_rsa',
    sshPort: 22,
    deployPath: '/var/www/app',
  };

  test('buildServerEnvEntry still defaults to manual (env add safety)', () => {
    const entry = buildServerEnvEntry(baseAnswers, 'frontend', 'demo', null, null);
    expect(entry.trigger).toBe('manual');
  });

  test('single-env init → applyInitTriggerDefaults sets trigger push', () => {
    const environments = {
      default: buildServerEnvEntry(
        { ...baseAnswers, envName: 'default' },
        'frontend',
        'demo',
        null,
        null
      ),
    };
    expect(environments.default.trigger).toBe('manual');
    applyInitTriggerDefaults(environments, ['default'], 'default');
    expect(environments.default.trigger).toBe('push');
  });

  test('multi-env: grandfathered push, others manual; reminder names real envs', () => {
    const deploy = ['development', 'staging', 'production'];
    /** @type {Record<string, ReturnType<typeof buildServerEnvEntry>>} */
    const environments = {};
    for (const name of deploy) {
      environments[name] = buildServerEnvEntry(
        {
          ...baseAnswers,
          envName: name,
          deployType: name === 'staging' ? 'docker' : 'ssh',
          dockerImageName: 'org/app',
        },
        'frontend',
        'demo',
        null,
        null
      );
    }
    const defaultEnvironment = 'development';
    applyInitTriggerDefaults(environments, deploy, defaultEnvironment);

    expect(environments.development.trigger).toBe('push');
    expect(environments.staging.trigger).toBe('manual');
    expect(environments.production.trigger).toBe('manual');

    const reminder = formatMultiEnvTriggerReminder(defaultEnvironment, deploy);
    expect(reminder).toContain('"development"');
    expect(reminder).toContain('"staging"');
    expect(reminder).toContain('"production"');
    expect(reminder).toContain('auto-deploys on push');
    expect(reminder).toContain('deployhub sync-workflows');
    expect(reminder).toMatch(/"staging": \{ "trigger": "push"/);
  });
});
