import { jest } from '@jest/globals';
import { isInteractive, isNonInteractive } from '../src/utils/interactive.js';
import {
  namespaceExists,
  ensureKubernetesNamespace,
} from '../src/utils/kubernetes-namespace.js';

const GET_NS_ARGS = [
  'get',
  'namespace',
  'demo-react-project',
  '--ignore-not-found',
  '-o',
  'name',
];

describe('isInteractive', () => {
  test('returns false when CI is set', () => {
    expect(isInteractive({ env: { CI: 'true' }, stdinIsTTY: true })).toBe(false);
    expect(isNonInteractive({ env: { CI: '1' }, stdinIsTTY: true })).toBe(true);
  });

  test('returns false when GITHUB_ACTIONS is set', () => {
    expect(isInteractive({ env: { GITHUB_ACTIONS: 'true' }, stdinIsTTY: true })).toBe(
      false
    );
  });

  test('returns false when stdin is not a TTY', () => {
    expect(isInteractive({ env: {}, stdinIsTTY: false })).toBe(false);
  });

  test('returns true for local TTY without CI markers', () => {
    expect(isInteractive({ env: {}, stdinIsTTY: true })).toBe(true);
  });
});

describe('ensureKubernetesNamespace', () => {
  /** @type {ReturnType<typeof createLog>} */
  let log;
  /** @type {jest.Mock} */
  let execaFn;
  /** @type {jest.Mock} */
  let confirmFn;

  function createLog() {
    return {
      info: jest.fn(),
      warn: jest.fn(),
      success: jest.fn(),
      error: jest.fn(),
    };
  }

  beforeEach(() => {
    log = createLog();
    execaFn = jest.fn();
    confirmFn = jest.fn();
  });

  test('existing namespace is a no-op (does not create)', async () => {
    execaFn.mockResolvedValue({ stdout: 'namespace/demo-react-project\n' });

    const result = await ensureKubernetesNamespace({
      namespace: 'demo-react-project',
      log,
      execaFn,
      confirmFn,
      interactive: true,
    });

    expect(result).toEqual({ existed: true, created: false });
    expect(execaFn).toHaveBeenCalledTimes(1);
    expect(execaFn).toHaveBeenCalledWith('kubectl', GET_NS_ARGS, expect.any(Object));
    expect(confirmFn).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('missing namespace + interactive confirm creates it', async () => {
    execaFn
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' });
    confirmFn.mockResolvedValue(true);

    const result = await ensureKubernetesNamespace({
      namespace: 'demo-react-project',
      log,
      execaFn,
      confirmFn,
      interactive: true,
    });

    expect(result).toEqual({ existed: false, created: true });
    expect(log.warn).toHaveBeenCalledWith(
      "Namespace 'demo-react-project' was not found on the cluster."
    );
    expect(confirmFn).toHaveBeenCalledWith('demo-react-project');
    expect(execaFn).toHaveBeenNthCalledWith(
      2,
      'kubectl',
      ['create', 'namespace', 'demo-react-project'],
      expect.any(Object)
    );
    expect(log.success).toHaveBeenCalledWith("Created namespace 'demo-react-project'");
  });

  test('missing namespace + interactive decline aborts cleanly', async () => {
    execaFn.mockResolvedValueOnce({ stdout: '' });
    confirmFn.mockResolvedValue(false);

    await expect(
      ensureKubernetesNamespace({
        namespace: 'demo-react-project',
        log,
        execaFn,
        confirmFn,
        interactive: true,
      })
    ).rejects.toThrow(
      /Namespace 'demo-react-project' does not exist\. Create it manually with: kubectl create namespace demo-react-project/
    );

    expect(execaFn).toHaveBeenCalledTimes(1);
    expect(execaFn).not.toHaveBeenCalledWith(
      'kubectl',
      ['create', 'namespace', 'demo-react-project'],
      expect.any(Object)
    );
  });

  test('missing namespace + non-interactive CI auto-creates without prompting', async () => {
    execaFn
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' });

    const result = await ensureKubernetesNamespace({
      namespace: 'demo-react-project',
      log,
      execaFn,
      confirmFn,
      interactive: false,
    });

    expect(result).toEqual({ existed: false, created: true });
    expect(confirmFn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "Non-interactive session detected — creating namespace 'demo-react-project' automatically."
    );
    expect(execaFn).toHaveBeenNthCalledWith(
      2,
      'kubectl',
      ['create', 'namespace', 'demo-react-project'],
      expect.any(Object)
    );
    expect(log.success).toHaveBeenCalledWith("Created namespace 'demo-react-project'");
  });

  test('kubectl get connection/auth failure aborts without prompt or create', async () => {
    const err = Object.assign(new Error('Command failed with exit code 1'), {
      exitCode: 1,
      stderr:
        'Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused',
    });
    execaFn.mockRejectedValueOnce(err);

    await expect(
      ensureKubernetesNamespace({
        namespace: 'demo-react-project',
        log,
        execaFn,
        confirmFn,
        interactive: true,
      })
    ).rejects.toThrow(
      /Failed to check whether namespace 'demo-react-project' exists: Unable to connect to the server: dial tcp 127\.0\.0\.1:6443: connect: connection refused/
    );

    expect(confirmFn).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(execaFn).toHaveBeenCalledTimes(1);
    expect(execaFn).toHaveBeenCalledWith('kubectl', GET_NS_ARGS, expect.any(Object));
    expect(execaFn).not.toHaveBeenCalledWith(
      'kubectl',
      ['create', 'namespace', 'demo-react-project'],
      expect.any(Object)
    );
  });

  test('namespaceExists returns false when --ignore-not-found yields empty stdout', async () => {
    execaFn.mockResolvedValue({ stdout: '  \n' });
    await expect(namespaceExists('missing', { execaFn })).resolves.toBe(false);
    expect(execaFn).toHaveBeenCalledWith(
      'kubectl',
      ['get', 'namespace', 'missing', '--ignore-not-found', '-o', 'name'],
      expect.any(Object)
    );
  });

  test('namespaceExists returns true when kubectl get succeeds with a name', async () => {
    execaFn.mockResolvedValue({ stdout: 'namespace/default\n' });
    await expect(namespaceExists('default', { execaFn })).resolves.toBe(true);
  });

  test('namespaceExists rethrows connection/auth errors instead of treating as missing', async () => {
    const err = Object.assign(new Error('Command failed with exit code 1'), {
      exitCode: 1,
      stderr: 'error: You must be logged in to the server (Unauthorized)',
    });
    execaFn.mockRejectedValue(err);

    await expect(namespaceExists('demo-react-project', { execaFn })).rejects.toThrow(
      /Failed to check whether namespace 'demo-react-project' exists: error: You must be logged in to the server \(Unauthorized\)/
    );
  });
});
