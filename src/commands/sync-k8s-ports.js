import chalk from 'chalk';
import { loadConfig, loadEnv } from '../core/config.js';
import { resolveContainerPort } from '../utils/dockerfile-expose.js';
import {
  getDefaultKubernetesManifestPaths,
  syncKubernetesManifestPorts,
} from '../utils/kubernetes-manifests.js';
import fs from 'fs-extra';

/**
 * Surgically fix containerPort/targetPort in existing k8s manifests from Dockerfile EXPOSE.
 * @param {import('commander').Command} program
 */
export function registerSyncK8sPortsCommand(program) {
  program
    .command('sync-k8s-ports')
    .description(
      'Update only containerPort/targetPort in k8s/deployment.yaml and k8s/service.yaml ' +
        'from the Dockerfile EXPOSE port (or config/fallback). Does not change replicas, ' +
        'resources, env, probes, or Service port. Heavily customized / multi-container ' +
        'manifests may need a manual review.'
    )
    .action(async () => {
      loadEnv();
      const cwd = process.cwd();
      const config = await loadConfig(cwd);

      const { deploymentPath, servicePath } = getDefaultKubernetesManifestPaths(cwd);
      const hasDeployment = await fs.pathExists(deploymentPath);
      const hasService = await fs.pathExists(servicePath);

      if (!hasDeployment && !hasService) {
        console.log(
          chalk.yellow(
            'No k8s/deployment.yaml or k8s/service.yaml found — nothing to patch. ' +
              'Generate starter manifests via deployhub init, or add manifests under ./k8s/.'
          )
        );
        return;
      }

      const { port, source } = await resolveContainerPort(cwd, config);
      const result = await syncKubernetesManifestPorts(cwd, port);

      console.log(
        chalk.green(
          `✓ Resolved container port ${port} (source: ${source})`
        )
      );

      if (result.patched.length === 0) {
        console.log(chalk.gray('  Port fields already match — no files changed.'));
      } else {
        for (const file of result.patched) {
          console.log(chalk.gray(`  Updated ${file}`));
        }
      }

      console.log('');
      console.log(
        chalk.yellow(
          'Note: Only containerPort and targetPort are updated. Replicas, resources, env, ' +
            'probes, and Service port: are left unchanged. If your manifests are heavily ' +
            'customized (multiple containers, non-standard field layout), review the diff ' +
            'manually before deploying.'
        )
      );
    });
}

export default { registerSyncK8sPortsCommand };
