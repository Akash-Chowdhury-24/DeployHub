import { execa } from 'execa';

/**
 * After kubectl apply, set the Deployment container image to fullImage and
 * rollout-restart only when the live image ref is already identical (same
 * registry + name + tag), so a new digest under a reused tag still redeploys.
 *
 * @param {{
 *   deploymentName: string,
 *   fullImage: string,
 *   kubectlArgs: (args: string[]) => string[],
 *   getKubectlEnv: () => NodeJS.ProcessEnv,
 *   log: { info: Function, warn: Function, success?: Function },
 *   execaFn?: typeof execa,
 * }} options
 * @returns {Promise<{ beforeImage: string, setImage: boolean, restarted: boolean }>}
 */
export async function syncKubernetesDeploymentImage(options) {
  const {
    deploymentName,
    fullImage,
    kubectlArgs,
    getKubectlEnv,
    log,
    execaFn = execa,
  } = options;

  const beforeImage = await readDeploymentContainerImage({
    deploymentName,
    kubectlArgs,
    getKubectlEnv,
    execaFn,
  });

  let setImage = false;
  try {
    await execaFn(
      'kubectl',
      kubectlArgs([
        'set',
        'image',
        `deployment/${deploymentName}`,
        `${deploymentName}=${fullImage}`,
      ]),
      { stdio: 'pipe', env: getKubectlEnv() }
    );
    setImage = true;
  } catch {
    log.warn('kubectl set image skipped (deployment name may differ from project name)');
  }

  // Compare full image refs (registry + name + tag), not tag alone.
  if (beforeImage === fullImage) {
    log.info(
      `Image ref unchanged (${fullImage}) — running rollout restart so pods pick up a new digest`
    );
    await execaFn(
      'kubectl',
      kubectlArgs(['rollout', 'restart', `deployment/${deploymentName}`]),
      { stdio: 'inherit', env: getKubectlEnv() }
    );
    return { beforeImage, setImage, restarted: true };
  }

  return { beforeImage, setImage, restarted: false };
}

/**
 * @param {{
 *   deploymentName: string,
 *   kubectlArgs: (args: string[]) => string[],
 *   getKubectlEnv: () => NodeJS.ProcessEnv,
 *   execaFn: typeof execa,
 * }} options
 * @returns {Promise<string>}
 */
async function readDeploymentContainerImage(options) {
  const { deploymentName, kubectlArgs, getKubectlEnv, execaFn } = options;

  const jsonpath = `{.spec.template.spec.containers[?(@.name=="${deploymentName}")].image}`;
  try {
    const { stdout } = await execaFn(
      'kubectl',
      kubectlArgs(['get', 'deployment', deploymentName, '-o', `jsonpath=${jsonpath}`]),
      { stdio: 'pipe', env: getKubectlEnv() }
    );
    const trimmed = String(stdout || '').trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to containers[0]
  }

  try {
    const { stdout } = await execaFn(
      'kubectl',
      kubectlArgs([
        'get',
        'deployment',
        deploymentName,
        '-o',
        'jsonpath={.spec.template.spec.containers[0].image}',
      ]),
      { stdio: 'pipe', env: getKubectlEnv() }
    );
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

export default { syncKubernetesDeploymentImage };
