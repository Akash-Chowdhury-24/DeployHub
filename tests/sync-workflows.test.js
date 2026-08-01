import { jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const mockLoadConfig = jest.fn();
jest.unstable_mockModule('../src/core/config.js', () => ({
  loadConfig: mockLoadConfig,
  loadEnv: jest.fn(),
}));

const { ROLLBACK_WORKFLOW_FILENAME, DEPLOY_WORKFLOW_FILENAME } =
  await import('../src/utils/github-actions.js');
const { registerSyncWorkflowsCommand } = await import('../src/commands/sync-workflows.js');

describe('deployhub sync-workflows', () => {
  /** @type {string} */
  let tmp;
  /** @type {{ log: string[], command: import('commander').Command | null }} */
  let captured;

  beforeEach(async () => {
    jest.clearAllMocks();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-sync-wf-'));
    captured = { log: [], command: null };

    mockLoadConfig.mockResolvedValue({
      project: 'demo',
      storage: ['aws'],
      deploy: ['production'],
      environments: { production: { type: 'kubernetes' } },
      cli: { source: 'npm:@akash-chowdhury-24/deployhub' },
      projectType: 'frontend',
    });
  });

  afterEach(async () => {
    await fs.remove(tmp);
    jest.restoreAllMocks();
  });

  test('regenerates both workflow files without prompting', async () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tmp);
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      captured.log.push(args.map(String).join(' '));
    });

    const { Command } = await import('commander');
    const program = new Command();
    registerSyncWorkflowsCommand(program);
    await program.parseAsync(['node', 'test', 'sync-workflows']);

    const deployPath = path.join(tmp, '.github', 'workflows', DEPLOY_WORKFLOW_FILENAME);
    const rollbackPath = path.join(tmp, '.github', 'workflows', ROLLBACK_WORKFLOW_FILENAME);

    expect(await fs.pathExists(deployPath)).toBe(true);
    expect(await fs.pathExists(rollbackPath)).toBe(true);
    expect(mockLoadConfig).toHaveBeenCalled();

    const joined = captured.log.join('\n');
    expect(joined).toContain(DEPLOY_WORKFLOW_FILENAME);
    expect(joined).toContain(ROLLBACK_WORKFLOW_FILENAME);

    cwdSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('overwrite updates stale rollback file', async () => {
    const wfDir = path.join(tmp, '.github', 'workflows');
    await fs.ensureDir(wfDir);
    await fs.writeFile(path.join(wfDir, DEPLOY_WORKFLOW_FILENAME), 'old-deploy');
    await fs.writeFile(path.join(wfDir, ROLLBACK_WORKFLOW_FILENAME), 'old-rollback');

    jest.spyOn(process, 'cwd').mockReturnValue(tmp);
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const { Command } = await import('commander');
    const program = new Command();
    registerSyncWorkflowsCommand(program);
    await program.parseAsync(['node', 'test', 'sync-workflows']);

    const rollback = await fs.readFile(
      path.join(wfDir, ROLLBACK_WORKFLOW_FILENAME),
      'utf8'
    );
    expect(rollback).toContain('workflow_dispatch:');
    expect(rollback).not.toBe('old-rollback');
  });
});

describe('doctor rollback workflow check (logic)', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-doctor-rb-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('missing rollback file yields informational pass + sync-workflows hint', async () => {
    const { getRollbackWorkflowDoctorCheck } = await import('../src/utils/github-actions.js');
    const check = await getRollbackWorkflowDoctorCheck(tmp, {
      storage: ['aws'],
      deploy: ['production'],
    });
    expect(check).not.toBeNull();
    expect(check?.pass).toBe(true);
    expect(check?.message).toContain('deployhub sync-workflows');
    expect(check?.message).toContain(ROLLBACK_WORKFLOW_FILENAME);
  });

  test('present rollback file reports success', async () => {
    const { getRollbackWorkflowDoctorCheck } = await import('../src/utils/github-actions.js');
    await fs.ensureDir(path.join(tmp, '.github', 'workflows'));
    await fs.writeFile(
      path.join(tmp, '.github', 'workflows', ROLLBACK_WORKFLOW_FILENAME),
      'name: DeployHub Rollback\n'
    );
    const check = await getRollbackWorkflowDoctorCheck(tmp, {
      storage: ['aws'],
      deploy: ['production'],
    });
    expect(check?.pass).toBe(true);
    expect(check?.message).toContain('exists');
  });

  test('skipped when storage or deploy not configured', async () => {
    const { getRollbackWorkflowDoctorCheck } = await import('../src/utils/github-actions.js');
    expect(await getRollbackWorkflowDoctorCheck(tmp, { storage: [], deploy: ['p'] })).toBeNull();
    expect(await getRollbackWorkflowDoctorCheck(tmp, { storage: ['aws'], deploy: [] })).toBeNull();
  });
});
