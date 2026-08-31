import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  addDeployhubToPackageJson,
  getCliPackageJsonDependencyVersion,
  getCliInstallSpec,
  decideDeployhubDependencyVersionWrite,
  parseDependencyBaseVersion,
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
  /** @type {typeof console.log} */
  let originalLog;
  /** @type {string[]} */
  let logs;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-pkg-dep-'));
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'demo-app',
      version: '0.0.1',
    });
    logs = [];
    originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(' '));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
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

  test('reads ^2.0.18 from a real package.json with version 2.0.18 (not a hardcoded stale value)', async () => {
    const pkgPath = path.join(tmp, 'cli-package-2.0.18.json');
    await fs.writeJson(pkgPath, {
      name: '@akash-chowdhury-24/deployhub',
      version: '2.0.18',
    });
    expect(
      getCliPackageJsonDependencyVersion(DEFAULT_NPM_CLI_SOURCE, {
        packageJsonPath: pkgPath,
      })
    ).toBe('^2.0.18');
  });

  test('reads ^3.1.0 dynamically from a different package.json version (proves no hardcoded fixture)', async () => {
    const pkgPath = path.join(tmp, 'cli-package-3.1.0.json');
    await fs.writeJson(pkgPath, {
      name: '@akash-chowdhury-24/deployhub',
      version: '3.1.0',
    });
    expect(
      getCliPackageJsonDependencyVersion(DEFAULT_NPM_CLI_SOURCE, {
        packageJsonPath: pkgPath,
      })
    ).toBe('^3.1.0');
    // Must not accidentally return the other fixture or the old repo skew 1.0.6
    expect(
      getCliPackageJsonDependencyVersion(DEFAULT_NPM_CLI_SOURCE, {
        packageJsonPath: pkgPath,
      })
    ).not.toBe('^1.0.6');
    expect(
      getCliPackageJsonDependencyVersion(DEFAULT_NPM_CLI_SOURCE, {
        packageJsonPath: pkgPath,
      })
    ).not.toBe('^2.0.18');
  });

  test('falls back to "latest" when package.json is unreadable — never a hardcoded old semver', async () => {
    expect(
      getCliPackageJsonDependencyVersion(DEFAULT_NPM_CLI_SOURCE, {
        packageJsonPath: path.join(tmp, 'does-not-exist.json'),
      })
    ).toMatch(/^(latest|\^\d+\.\d+\.\d+)/);
    // If fallback path is hit exclusively (unreadable + getDeployHubVersion fails),
    // the only non-semver answer allowed is "latest". When getDeployHubVersion works
    // from the live package, a ^range is also fine — never ^1.0.6 specifically from a
    // hardcoded constant (there is none).
    const v = getCliPackageJsonDependencyVersion(DEFAULT_NPM_CLI_SOURCE, {
      packageJsonPath: path.join(tmp, 'missing.json'),
    });
    expect(v).not.toBe('^1.0.6');
  });

  test('github cli source keeps a valid git dependency value without double-wrapping', async () => {
    const src = 'github:Akash-Chowdhury-24/DeployHub';
    await addDeployhubToPackageJson(src, tmp);
    const pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe(src);
  });
});

describe('downgrade-safe DeployHub dependency writes', () => {
  /** @type {string} */
  let tmp;
  /** @type {typeof console.log} */
  let originalLog;
  /** @type {string[]} */
  let logs;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-pkg-guard-'));
    logs = [];
    originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(' '));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    await fs.remove(tmp);
  });

  test('existing ^2.0.19 + resolved 1.0.6 → does NOT overwrite; prints downgrade warning', async () => {
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'demo-app',
      version: '0.0.1',
      devDependencies: { [PKG]: '^2.0.19' },
    });

    await addDeployhubToPackageJson(DEFAULT_NPM_CLI_SOURCE, tmp, {
      proposedVersion: '^1.0.6',
    });

    const pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe('^2.0.19');
    expect(logs.join('\n')).toMatch(/Skipped updating package\.json dependency version/);
    expect(logs.join('\n')).toMatch(/1\.0\.6/);
    expect(logs.join('\n')).toMatch(/2\.0\.19/);
  });

  test('existing ^2.0.19 + resolved 2.0.20 → upgrades to ^2.0.20', async () => {
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'demo-app',
      version: '0.0.1',
      devDependencies: { [PKG]: '^2.0.19' },
    });

    await addDeployhubToPackageJson(DEFAULT_NPM_CLI_SOURCE, tmp, {
      proposedVersion: '^2.0.20',
    });

    const pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe('^2.0.20');
    expect(logs.join('\n')).not.toMatch(/Skipped updating/);
  });

  test('no existing entry + resolved 2.0.19 → writes ^2.0.19 (first-time)', async () => {
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'demo-app',
      version: '0.0.1',
    });

    await addDeployhubToPackageJson(DEFAULT_NPM_CLI_SOURCE, tmp, {
      proposedVersion: '^2.0.19',
    });

    const pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe('^2.0.19');
  });

  test('malformed existing value → no overwrite, warning, no crash', async () => {
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'demo-app',
      version: '0.0.1',
      devDependencies: { [PKG]: 'not-a-valid-semver!!!' },
    });

    await addDeployhubToPackageJson(DEFAULT_NPM_CLI_SOURCE, tmp, {
      proposedVersion: '^2.0.19',
    });

    const pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe('not-a-valid-semver!!!');
    expect(logs.join('\n')).toMatch(/could not compare|Skipped updating/);
  });

  test('init re-run still allowed: upgrades when newer, never downgrades (scripts always ensured)', async () => {
    // Judgment: re-run of init MAY update the pin on upgrade, but the downgrade
    // guard makes re-runs safe — we do not "write once only".
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'demo-app',
      version: '0.0.1',
      devDependencies: { [PKG]: '^2.0.18' },
    });

    await addDeployhubToPackageJson(DEFAULT_NPM_CLI_SOURCE, tmp, {
      proposedVersion: '^2.0.19',
    });
    let pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe('^2.0.19');
    expect(pkg.scripts['deployhub:build']).toBe('deployhub build');

    delete pkg.scripts;
    await fs.writeJson(path.join(tmp, 'package.json'), pkg);
    await addDeployhubToPackageJson(DEFAULT_NPM_CLI_SOURCE, tmp, {
      proposedVersion: '^1.0.6',
    });
    pkg = await fs.readJson(path.join(tmp, 'package.json'));
    expect(pkg.devDependencies[PKG]).toBe('^2.0.19');
    expect(pkg.scripts['deployhub:build']).toBe('deployhub build');
    expect(logs.join('\n')).toMatch(/lower than what's already/);
  });

  test('decideDeployhubDependencyVersionWrite / parseDependencyBaseVersion unit cases', () => {
    expect(parseDependencyBaseVersion('^2.0.19')).toBe('2.0.19');
    expect(parseDependencyBaseVersion('latest')).toBeNull();
    expect(decideDeployhubDependencyVersionWrite(null, '^2.0.19')).toEqual({
      write: true,
      value: '^2.0.19',
      warning: null,
    });
    expect(decideDeployhubDependencyVersionWrite('^2.0.19', '^1.0.6').write).toBe(
      false
    );
    expect(decideDeployhubDependencyVersionWrite('^2.0.19', '^2.0.20').value).toBe(
      '^2.0.20'
    );
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
    expect(entry.branch).toBeUndefined();
  });

  test('buildServerEnvEntry stores trigger push + branch from prompt answers', () => {
    const entry = buildServerEnvEntry(
      { ...baseAnswers, trigger: 'push', branch: 'dev' },
      'frontend',
      'demo',
      null,
      null
    );
    expect(entry.trigger).toBe('push');
    expect(entry.branch).toBe('dev');
    expect(entry.config.branch).toBeUndefined();
  });

  test('buildServerEnvEntry does not store branch on manual trigger', () => {
    const entry = buildServerEnvEntry(
      { ...baseAnswers, trigger: 'manual', branch: 'dev' },
      'frontend',
      'demo',
      null,
      null
    );
    expect(entry.trigger).toBe('manual');
    expect(entry.branch).toBeUndefined();
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
