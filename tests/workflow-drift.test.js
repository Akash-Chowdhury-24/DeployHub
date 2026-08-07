import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  detectWorkflowConfigDrift,
  getWorkflowDriftDoctorChecks,
  generateWorkflowYaml,
  generateRollbackWorkflowYaml,
  DEPLOY_WORKFLOW_FILENAME,
  ROLLBACK_WORKFLOW_FILENAME,
} from '../src/utils/github-actions.js';

const CLI = 'npm:@akash-chowdhury-24/deployhub';

describe('workflow config drift detection', () => {
  const twoEnvConfig = {
    project: 'demo',
    projectType: 'frontend',
    storage: ['local'],
    defaultEnvironment: 'staging',
    unprefixedSecretEnvironment: 'staging',
    environments: {
      staging: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { host: 's' },
      },
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { host: 'p' },
      },
    },
  };

  test('config has 2 envs, checked-in file only lists 1 → drift names missing env', () => {
    const stale = generateWorkflowYaml(
      ['local'],
      ['staging'],
      { staging: twoEnvConfig.environments.staging },
      CLI,
      {
        ...twoEnvConfig,
        environments: { staging: twoEnvConfig.environments.staging },
        unprefixedSecretEnvironment: 'staging',
      }
    );

    const drift = detectWorkflowConfigDrift(stale, twoEnvConfig, DEPLOY_WORKFLOW_FILENAME);
    expect(drift.drifted).toBe(true);
    expect(drift.missingEnvs).toContain('production');
    expect(drift.summary).toMatch(/"production"/);
    expect(drift.summary).toMatch(/dispatch dropdown/);
  });

  test('config requires prefixed secret the checked-in fixture lacks → drift', () => {
    // Fixture generated for staging-only (unprefixed SSH_HOST); current config needs PRODUCTION_*
    const stale = generateRollbackWorkflowYaml(
      ['local'],
      ['staging'],
      { staging: twoEnvConfig.environments.staging },
      CLI,
      {
        ...twoEnvConfig,
        environments: { staging: twoEnvConfig.environments.staging },
        unprefixedSecretEnvironment: 'staging',
      }
    );

    const drift = detectWorkflowConfigDrift(stale, twoEnvConfig, ROLLBACK_WORKFLOW_FILENAME);
    expect(drift.drifted).toBe(true);
    expect(drift.missingSecrets.some((k) => k.startsWith('PRODUCTION_'))).toBe(true);
    expect(drift.summary).toMatch(/missing secret/);
  });

  test('disabled env missing from dropdown is not drift (only enabled required)', () => {
    const config = {
      ...twoEnvConfig,
      environments: {
        staging: twoEnvConfig.environments.staging,
        production: {
          ...twoEnvConfig.environments.production,
          enabled: false,
        },
      },
    };
    const fresh = generateWorkflowYaml(
      ['local'],
      ['staging'],
      config.environments,
      CLI,
      config
    );
    const drift = detectWorkflowConfigDrift(fresh, config, DEPLOY_WORKFLOW_FILENAME);
    expect(drift.missingEnvs).not.toContain('production');
    expect(fresh).not.toContain('- production\n');
  });

  test('config and checked-in fixture in sync → no drift', () => {
    const fresh = generateRollbackWorkflowYaml(
      ['local'],
      ['staging', 'production'],
      twoEnvConfig.environments,
      CLI,
      twoEnvConfig
    );
    const drift = detectWorkflowConfigDrift(fresh, twoEnvConfig, ROLLBACK_WORKFLOW_FILENAME);
    expect(drift.drifted).toBe(false);
    expect(drift.missingEnvs).toEqual([]);
    expect(drift.missingSecrets).toEqual([]);
  });

  test('missing file entirely → drift check does not fire; rollback-missing still separate', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-drift-'));
    try {
      const driftChecks = await getWorkflowDriftDoctorChecks(tmp, twoEnvConfig);
      expect(driftChecks).toEqual([]);

      const { getRollbackWorkflowDoctorCheck } = await import('../src/utils/github-actions.js');
      const missing = await getRollbackWorkflowDoctorCheck(tmp, {
        storage: ['aws'],
        deploy: ['staging'],
      });
      expect(missing?.pass).toBe(true);
      expect(missing?.message).toMatch(/Missing/);
      expect(missing?.message).toMatch(/sync-workflows/);
    } finally {
      await fs.remove(tmp);
    }
  });

  test('doctor drift check message names file and suggests sync-workflows', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-drift-msg-'));
    try {
      const wfDir = path.join(tmp, '.github', 'workflows');
      await fs.ensureDir(wfDir);
      const stale = generateWorkflowYaml(
        ['local'],
        ['staging'],
        { staging: twoEnvConfig.environments.staging },
        CLI,
        {
          ...twoEnvConfig,
          environments: { staging: twoEnvConfig.environments.staging },
        }
      );
      await fs.writeFile(path.join(wfDir, DEPLOY_WORKFLOW_FILENAME), stale);

      const checks = await getWorkflowDriftDoctorChecks(tmp, twoEnvConfig);
      expect(checks.length).toBeGreaterThanOrEqual(1);
      expect(checks[0].pass).toBe(true); // informational
      expect(checks[0].message).toContain(DEPLOY_WORKFLOW_FILENAME);
      expect(checks[0].message).toMatch(/out of date/);
      expect(checks[0].message).toMatch(/"production"/);
      expect(checks[0].message).toContain('deployhub sync-workflows');
    } finally {
      await fs.remove(tmp);
    }
  });
});
