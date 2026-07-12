import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { createLogger } from '../../logger/index.js';
import { extractArtifact } from '../../artifact/engine.js';
import {
  describeInterpretedBackendGap,
  generateDotnetRuntimeDockerfile,
  generateFrontendRuntimeDockerfile,
  generateGoRuntimeDockerfile,
  generateSpringRuntimeDockerfile,
  isFrontendStaticFramework,
  isInterpretedBackendFramework,
  resolveDockerImageRef,
} from '../../utils/docker-image.js';

/**
 * @param {import('../../core/config.js').DeployHubConfig} config
 * @param {string} envName
 * @param {Record<string, string>} [env]
 */
export function createDockerProvider(config, envName, env = process.env) {
  const log = createLogger('docker');

  const { fullImage, latestImage, legacyLatestImage, imageTag } =
    resolveDockerImageRef(config, env);
  const registryUrl = env.DOCKER_REGISTRY_URL || '';
  const registryUser = env.DOCKER_REGISTRY_USERNAME || '';
  const registryToken = env.DOCKER_REGISTRY_TOKEN || '';
  const dockerHost = env.DOCKER_HOST || '';

  function getDockerEnv() {
    /** @type {Record<string, string>} */
    const dockerEnv = { ...process.env };
    if (dockerHost) dockerEnv.DOCKER_HOST = dockerHost;
    if (env.DOCKER_TLS_VERIFY) dockerEnv.DOCKER_TLS_VERIFY = env.DOCKER_TLS_VERIFY;
    if (env.DOCKER_CERT_PATH) dockerEnv.DOCKER_CERT_PATH = env.DOCKER_CERT_PATH;
    return dockerEnv;
  }

  function hasRegistryCredentials() {
    return Boolean(registryUser && registryToken);
  }

  async function dockerLogin() {
    if (!hasRegistryCredentials()) return;
    const registry = registryUrl || 'https://index.docker.io/v1/';
    log.info('Logging in to container registry...');
    await execa(
      'docker',
      ['login', registry, '-u', registryUser, '--password-stdin'],
      {
        input: registryToken,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: getDockerEnv(),
      }
    );
  }

  /**
   * Push only when registry credentials are configured. Avoids a noisy failed
   * push to Docker Hub for local-only image names.
   */
  async function maybePushImage() {
    if (!hasRegistryCredentials()) {
      log.info(
        'docker push skipped (DOCKER_REGISTRY_USERNAME/TOKEN not set — local image only)'
      );
      return;
    }

    log.info(`Pushing ${fullImage} to registry...`);
    await execa('docker', ['push', fullImage], {
      stdio: 'inherit',
      env: getDockerEnv(),
    });
    log.success(`Pushed ${fullImage}`);
  }

  /**
   * @param {string} ref
   */
  async function imageExists(ref) {
    try {
      await execa('docker', ['image', 'inspect', ref], {
        stdio: 'pipe',
        env: getDockerEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prefer the image already built during the pipeline `docker` stage.
   * Retag when the pipeline used `:latest` and deploy needs a version tag.
   */
  async function ensureImageFromPipeline() {
    if (await imageExists(fullImage)) {
      log.info(`Reusing existing image ${fullImage}`);
      return true;
    }

    const candidates = [...new Set([latestImage, legacyLatestImage])].filter(
      (ref) => ref !== fullImage
    );

    for (const candidate of candidates) {
      if (!(await imageExists(candidate))) continue;
      log.info(`Re-tagging pipeline image ${candidate} → ${fullImage}`);
      await execa('docker', ['tag', candidate, fullImage], {
        stdio: 'inherit',
        env: getDockerEnv(),
      });
      return true;
    }

    return false;
  }

  /**
   * Backend artifacts omit lockfiles/node_modules. Prefer a pre-built binary
   * runtime image when present; otherwise fail with an actionable error.
   * @param {string} buildContext
   * @param {Record<string, unknown>} metadata
   * @param {string} framework
   * @param {number} port
   */
  async function prepareBackendBuildContext(buildContext, metadata, framework, port) {
    if (framework === 'spring') {
      const targetDir = path.join(buildContext, 'target');
      if (await fs.pathExists(targetDir)) {
        const jars = (await fs.readdir(targetDir)).filter((f) => f.endsWith('.jar'));
        if (jars.length > 0) {
          const jarRel = `target/${jars[0]}`;
          log.info(`Building runtime image from pre-built JAR (${jarRel})...`);
          await fs.writeFile(
            path.join(buildContext, 'Dockerfile'),
            generateSpringRuntimeDockerfile(jarRel, port)
          );
          return;
        }
      }
    }

    if (framework === 'go') {
      const binDir = path.join(buildContext, 'bin');
      if (await fs.pathExists(binDir)) {
        const bins = await fs.readdir(binDir);
        if (bins.length > 0) {
          const binRel = `bin/${bins[0]}`;
          log.info(`Building runtime image from pre-built Go binary (${binRel})...`);
          await fs.writeFile(
            path.join(buildContext, 'Dockerfile'),
            generateGoRuntimeDockerfile(binRel, port)
          );
          return;
        }
      }
    }

    if (framework === 'dotnet') {
      const publishDir =
        /** @type {string} */ (metadata.buildOutput) ||
        config.buildOutput ||
        'publish';
      const publishPath = path.join(buildContext, publishDir);
      if (await fs.pathExists(publishPath)) {
        log.info(`Building runtime image from pre-built .NET output (${publishDir}/)...`);
        await fs.writeFile(
          path.join(buildContext, 'Dockerfile'),
          generateDotnetRuntimeDockerfile(publishDir, port)
        );
        return;
      }
    }

    const dockerfilePath = path.join(buildContext, 'Dockerfile');
    if (!(await fs.pathExists(dockerfilePath))) {
      throw new Error(
        'No Dockerfile found in artifact and no pipeline image to reuse. ' +
          'Add a Dockerfile and enable pipeline.docker so the image is built from project source.'
      );
    }

    // Interpreted backends (Node/Python/PHP/Ruby): never rebuild from artifact.
    // Artifacts ship source + manifest files, not installed dependency trees.
    if (isInterpretedBackendFramework(framework)) {
      const gap = describeInterpretedBackendGap(framework);
      throw new Error(
        `Cannot rebuild ${gap.ecosystem} backend image "${fullImage}" from the packaged artifact.\n` +
          `Backend artifacts include source/manifests but not ${gap.missing}, ` +
          `so Dockerfiles that run \`${gap.installCmd}\` cannot reliably succeed from the artifact alone.\n\n` +
          'What to do instead:\n' +
          '  1. Enable pipeline.docker in deployhub.config.json (default when Docker deploy is selected).\n' +
          '  2. Run a full `deployhub build` so the image is built from the project root (with full deps).\n' +
          '  3. Deploy will reuse that local image (retag/push/run) — it will not rebuild from the artifact.\n\n' +
          `Standalone \`deployhub deploy\` without a pre-built local image is not supported for ${gap.ecosystem} backends.`
      );
    }

    // Remaining backends (unknown frameworks): try the packaged Dockerfile, but warn.
    log.warn(
      'Building backend image from extracted artifact. Prefer pipeline.docker so the image ' +
        'is built once from full project source, then reused on deploy.'
    );
  }

  /**
   * Standalone deploy fallback: extract the packaged artifact and build a
   * runtime image from pre-built output (frontend) or compiled backend artifacts.
   * Never builds from artifactDir root — that only has zip/metadata + a source Dockerfile.
   * @param {string} artifactDir
   */
  async function buildFromArtifactContents(artifactDir) {
    const zipPath = path.join(artifactDir, 'artifact.zip');
    if (!(await fs.pathExists(zipPath))) {
      throw new Error(
        `No local image found for ${fullImage} and no artifact.zip to build from. ` +
          'Enable pipeline.docker so the image is built from project source, or run deployhub build first.'
      );
    }

    const buildContext = path.join(artifactDir, '_docker_build');
    await fs.remove(buildContext);
    await extractArtifact(artifactDir, buildContext);

    try {
      const metadataPath = path.join(buildContext, 'metadata.json');
      const metadata = (await fs.pathExists(metadataPath))
        ? await fs.readJson(metadataPath)
        : {};

      const projectType = metadata.projectType || config.projectType || 'frontend';
      const framework =
        metadata.framework ||
        config.framework ||
        config.frontend?.framework ||
        '';
      const buildOutput =
        metadata.buildOutput ||
        config.buildOutput ||
        config.frontend?.buildOutput ||
        'dist';
      const port =
        Number(metadata.port) ||
        config.port ||
        config.backend?.port ||
        3000;

      const composePath = path.join(buildContext, 'docker-compose.yml');
      if (await fs.pathExists(composePath)) {
        log.info('Building via docker compose from extracted artifact...');
        await execa('docker', ['compose', 'up', '-d', '--build'], {
          cwd: buildContext,
          stdio: 'inherit',
          env: getDockerEnv(),
        });
        return { ranCompose: true };
      }

      const isStaticFrontend =
        projectType === 'frontend' || isFrontendStaticFramework(framework);

      if (isStaticFrontend) {
        const outputDir = path.join(buildContext, buildOutput);
        if (!(await fs.pathExists(outputDir))) {
          throw new Error(
            `Frontend artifact is missing build output "${buildOutput}". ` +
              'Cannot build a runtime image from this artifact.'
          );
        }
        log.info(
          `Building runtime image from pre-built ${buildOutput}/ (no source rebuild)...`
        );
        await fs.writeFile(
          path.join(buildContext, 'Dockerfile'),
          generateFrontendRuntimeDockerfile(buildOutput)
        );
      } else {
        await prepareBackendBuildContext(buildContext, metadata, framework, port);
      }

      await execa('docker', ['build', '-t', fullImage, '.'], {
        cwd: buildContext,
        stdio: 'inherit',
        env: getDockerEnv(),
      });
      return { ranCompose: false };
    } finally {
      await fs.remove(buildContext).catch(() => {});
    }
  }

  /**
   * @param {string} artifactDir
   */
  async function deploy(artifactDir) {
    log.info(`Deploying via Docker (image: ${fullImage})...`);
    const dockerEnv = getDockerEnv();

    await dockerLogin();

    const reused = await ensureImageFromPipeline();
    let ranCompose = false;

    if (!reused) {
      const result = await buildFromArtifactContents(artifactDir);
      ranCompose = Boolean(result?.ranCompose);
    }

    if (ranCompose) {
      log.success('Docker deployment complete');
      return;
    }

    await maybePushImage();

    // Keep :latest in sync when deploy uses a version tag
    if (imageTag !== 'latest' && fullImage !== latestImage) {
      await execa('docker', ['tag', fullImage, latestImage], {
        stdio: 'pipe',
        env: dockerEnv,
      }).catch(() => {});
    }

    await execa(
      'docker',
      ['rm', '-f', config.project],
      { stdio: 'pipe', env: dockerEnv }
    ).catch(() => {});

    await execa('docker', ['run', '-d', '--rm', '--name', config.project, fullImage], {
      stdio: 'inherit',
      env: dockerEnv,
    });

    log.success('Docker deployment complete');
  }

  async function rollback(artifactDir) {
    log.info('Rolling back Docker deployment (redeploy previous artifact)...');
    await deploy(artifactDir);
  }

  async function healthCheck() {
    const url = config.healthCheck?.url;
    if (!url) return true;

    try {
      const { stdout } = await execa(
        'docker',
        ['ps', '--filter', `name=${config.project}`, '--format', '{{.Status}}'],
        { stdio: 'pipe', env: getDockerEnv() }
      );
      return stdout.includes('Up');
    } catch {
      return false;
    }
  }

  async function testConnection() {
    await execa('docker', ['info'], { stdio: 'pipe', env: getDockerEnv() });
  }

  return { deploy, rollback, healthCheck, testConnection };
}

export default { createDockerProvider };
