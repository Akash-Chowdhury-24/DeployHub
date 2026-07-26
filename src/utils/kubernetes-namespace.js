import { execa } from 'execa';
import inquirer from 'inquirer';
import { isInteractive } from './interactive.js';

/**
 * @param {unknown} err
 * @returns {string}
 */
function kubectlErrorDetail(err) {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (err).stderr || '').trim();
    if (stderr) return stderr;
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * Check whether a namespace exists using a cluster-scoped get that exits 0 for
 * both found and missing. Non-zero exits (auth, connectivity, bad kubeconfig)
 * are rethrown — they must not be treated as "not found".
 *
 * @param {string} namespace
 * @param {{
 *   kubectlArgs?: (args: string[]) => string[],
 *   getKubectlEnv?: () => NodeJS.ProcessEnv,
 *   execaFn?: typeof execa,
 * }} [options]
 * @returns {Promise<boolean>}
 */
export async function namespaceExists(namespace, options = {}) {
  const kubectlArgs = options.kubectlArgs || ((args) => args);
  const getKubectlEnv = options.getKubectlEnv || (() => process.env);
  const execaFn = options.execaFn || execa;

  try {
    const { stdout } = await execaFn(
      'kubectl',
      kubectlArgs(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name']),
      {
        stdio: 'pipe',
        env: getKubectlEnv(),
      }
    );
    return Boolean(stdout && String(stdout).trim());
  } catch (err) {
    throw new Error(
      `Failed to check whether namespace '${namespace}' exists: ${kubectlErrorDetail(err)}`,
      { cause: err instanceof Error ? err : undefined }
    );
  }
}

/**
 * @param {string} namespace
 * @returns {Promise<boolean>}
 */
async function defaultConfirmCreate(namespace) {
  const { create } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'create',
      message: `Namespace '${namespace}' does not exist. Create it now?`,
      default: true,
    },
  ]);
  return Boolean(create);
}

/**
 * Ensure the target namespace exists before kubectl apply.
 * Interactive: prompt to create. CI / non-TTY: auto-create with a clear log.
 * Connectivity/auth failures from the existence check abort before create/prompt.
 *
 * @param {{
 *   namespace: string,
 *   log: { info: Function, warn: Function, success: Function, error?: Function },
 *   kubectlArgs?: (args: string[]) => string[],
 *   getKubectlEnv?: () => NodeJS.ProcessEnv,
 *   execaFn?: typeof execa,
 *   confirmFn?: (namespace: string) => Promise<boolean>,
 *   interactive?: boolean,
 * }} options
 * @returns {Promise<{ existed: boolean, created: boolean }>}
 */
export async function ensureKubernetesNamespace(options) {
  const {
    namespace,
    log,
    kubectlArgs = (args) => args,
    getKubectlEnv = () => process.env,
    execaFn = execa,
    confirmFn = defaultConfirmCreate,
    interactive = isInteractive(),
  } = options;

  if (!namespace) {
    throw new Error('Kubernetes namespace is empty — set KUBE_NAMESPACE or config.project.');
  }

  // Throws on auth/connectivity/kubeconfig errors — only false means genuine NotFound.
  if (await namespaceExists(namespace, { kubectlArgs, getKubectlEnv, execaFn })) {
    return { existed: true, created: false };
  }

  log.warn(`Namespace '${namespace}' was not found on the cluster.`);

  let shouldCreate = true;
  if (interactive) {
    shouldCreate = await confirmFn(namespace);
    if (!shouldCreate) {
      throw new Error(
        `Namespace '${namespace}' does not exist. Create it manually with: kubectl create namespace ${namespace}`
      );
    }
  } else {
    log.info(
      `Non-interactive session detected — creating namespace '${namespace}' automatically.`
    );
  }

  await execaFn('kubectl', kubectlArgs(['create', 'namespace', namespace]), {
    stdio: 'inherit',
    env: getKubectlEnv(),
  });
  log.success(`Created namespace '${namespace}'`);
  return { existed: false, created: true };
}

export default { namespaceExists, ensureKubernetesNamespace };
