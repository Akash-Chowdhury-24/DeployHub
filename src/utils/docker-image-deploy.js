import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { extractArtifact } from '../artifact/engine.js';
import {
  describeInterpretedBackendGap,
  generateDotnetRuntimeDockerfile,
  generateFrontendRuntimeDockerfile,
  generateGoRuntimeDockerfile,
  generateSpringRuntimeDockerfile,
  isFrontendStaticFramework,
  isInterpretedBackendFramework,
  replaceDockerImageTag,
  resolveDockerImageRef,
  EXPLICIT_IMAGE_TAG_WARNING,
} from './docker-image.js';

/**
 * Classify `docker pull` failure for rollback logs / interpreted-backend errors.
 * @param {unknown} err
 * @returns {'not found'|'auth failed'|'network error'|string}
 */
export function classifyDockerPullFailure(err) {
  const execErr = /** @type {{ message?: string, stderr?: string, stdout?: string }} */ (err);
  const combined = `${execErr?.message || ''} ${execErr?.stderr || ''} ${execErr?.stdout || ''}`.toLowerCase();
  // Docker Hub reports missing repos as "denied" — check existence first.
  if (
    combined.includes('manifest unknown') ||
    combined.includes('not found') ||
    combined.includes('repository does not exist') ||
    combined.includes('no such image')
  ) {
    return 'not found';
  }
  if (
    combined.includes('unauthorized') ||
    combined.includes('authentication required') ||
    combined.includes('access denied') ||
    combined.includes('denied: requested access')
  ) {
    return 'auth failed';
  }
  if (
    combined.includes('network') ||
    combined.includes('timeout') ||
    combined.includes('timed out') ||
    combined.includes('econnrefused') ||
    combined.includes('connection refused') ||
    combined.includes('no such host') ||
    combined.includes('dial tcp')
  ) {
    return 'network error';
  }
  const stderr = String(execErr?.stderr || '').trim().split('\n').filter(Boolean).pop();
  return stderr || (err instanceof Error ? err.message : 'pull failed');
}

/**
 * @param {string} imageRef
 * @param {string} reason
 */
export function formatImageNotLocalAndPullFailed(imageRef, reason) {
  return (
    `Target image ${imageRef} not found locally and could not be pulled ` +
    `from the registry (${reason}).`
  );
}

/**
 * Shared Docker image build, reuse, push, and pullability logic used by
 * docker and kubernetes deploy providers.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, string>} [env]
 * @param {{ info: Function, warn: Function, success: Function }} log
 */
export function createDockerImageDeployContext(config, env = process.env, log) {
  const { fullImage, latestImage, legacyLatestImage, imageTag, tagSource } =
    resolveDockerImageRef(config, env);
  const registryUrl = env.DOCKER_REGISTRY_URL || '';
  const registryUser = env.DOCKER_REGISTRY_USERNAME || '';
  const registryToken = env.DOCKER_REGISTRY_TOKEN || '';
  // DOCKER_HOST here is only the raw CLI transport (tcp:// / ssh://).
  // docker remote.mode "ssh" is resolved in docker.js and must not be injected
  // into this shared helper — kubernetes.js uses the same context for build/push
  // and has no remote SSH docker host.
  const dockerHost = env.DOCKER_HOST || '';

  if (tagSource === 'explicit') {
    log.warn(EXPLICIT_IMAGE_TAG_WARNING);
  } else {
    log.info(`Using auto image tag '${imageTag}' (source: ${tagSource})`);
  }

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
   * @param {string} [imageRef]
   */
  async function maybePushImage(imageRef = fullImage) {
    if (!hasRegistryCredentials()) {
      log.info(
        'docker push skipped (DOCKER_REGISTRY_USERNAME/TOKEN not set — local image only)'
      );
      return;
    }

    log.info(`Pushing ${imageRef} to registry...`);
    await execa('docker', ['push', imageRef], {
      stdio: 'inherit',
      env: getDockerEnv(),
    });
    log.success(`Pushed ${imageRef}`);
  }

  /**
   * @param {string} ref
   */
  async function imageExistsLocally(ref) {
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
   * Rollback (and any skipImageReuse path): after a local-cache miss, pull the
   * exact tag from the registry before falling through to artifact rebuild.
   * @param {string} ref
   * @returns {Promise<{ ok: true, output: string }|{ ok: false, reason: string, output: string }>}
   */
  async function tryPullImage(ref) {
    log.info(`Pulling ${ref} from registry...`);
    try {
      const pulled = await execa('docker', ['pull', ref], {
        stdio: 'pipe',
        env: getDockerEnv(),
      });
      const output = [pulled.stdout, pulled.stderr].filter(Boolean).join('\n').trim();
      if (output) log.info(output);
      if (await imageExistsLocally(ref)) {
        log.success(`Pulled ${ref}`);
        return { ok: true, output };
      }
      return {
        ok: false,
        reason: 'pull reported success but image is still missing locally',
        output,
      };
    } catch (err) {
      const execErr = /** @type {{ stdout?: string, stderr?: string }} */ (err);
      const output = [execErr.stdout, execErr.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();
      if (output) log.info(output);
      return { ok: false, reason: classifyDockerPullFailure(err), output };
    }
  }

  /**
   * Prefer the image already built during the pipeline `docker` stage.
   * Retag when the pipeline used `:latest` and deploy needs a version tag.
   * @param {string} [imageRef]
   */
  async function ensureImageFromPipeline(imageRef = fullImage) {
    if (await imageExistsLocally(imageRef)) {
      log.info(`Reusing existing image ${imageRef}`);
      return true;
    }

    const candidates = [...new Set([latestImage, legacyLatestImage])].filter(
      (ref) => ref !== imageRef
    );

    for (const candidate of candidates) {
      if (!(await imageExistsLocally(candidate))) continue;
      log.info(`Re-tagging pipeline image ${candidate} → ${imageRef}`);
      await execa('docker', ['tag', candidate, imageRef], {
        stdio: 'inherit',
        env: getDockerEnv(),
      });
      return true;
    }

    return false;
  }

  /**
   * @param {string} buildContext
   * @param {Record<string, unknown>} metadata
   * @param {string} framework
   * @param {number} port
   * @param {string} [imageRef]
   */
  async function prepareBackendBuildContext(
    buildContext,
    metadata,
    framework,
    port,
    imageRef = fullImage
  ) {
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

    if (isInterpretedBackendFramework(framework)) {
      const gap = describeInterpretedBackendGap(framework);
      throw new Error(
        `Cannot rebuild ${gap.ecosystem} backend image "${imageRef}" from the packaged artifact.\n` +
          `Backend artifacts include source/manifests but not ${gap.missing}, ` +
          `so Dockerfiles that run \`${gap.installCmd}\` cannot reliably succeed from the artifact alone.\n\n` +
          'What to do instead:\n' +
          '  1. Enable pipeline.docker in deployhub.config.json (default when Docker deploy is selected).\n' +
          '  2. Run a full `deployhub build` so the image is built from the project root (with full deps).\n' +
          '  3. Deploy will reuse that local image (retag/push/run) — it will not rebuild from the artifact.\n\n' +
          `Standalone \`deployhub deploy\` without a pre-built local image is not supported for ${gap.ecosystem} backends.`
      );
    }

    log.warn(
      'Building backend image from extracted artifact. Prefer pipeline.docker so the image ' +
        'is built once from full project source, then reused on deploy.'
    );
  }

  /**
   * @param {string} artifactDir
   * @param {string} [imageRef]
   */
  async function buildFromArtifactContents(artifactDir, imageRef = fullImage) {
    const zipPath = path.join(artifactDir, 'artifact.zip');
    if (!(await fs.pathExists(zipPath))) {
      throw new Error(
        `No local image found for ${imageRef} and no artifact.zip to build from. ` +
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
        await prepareBackendBuildContext(
          buildContext,
          metadata,
          framework,
          port,
          imageRef
        );
      }

      await execa('docker', ['build', '-t', imageRef, '.'], {
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
   * Ensure a deployable image exists locally, then push when credentials are set.
   * @param {string} artifactDir
   * @param {{
   *   skipPush?: boolean,
   *   fullImage?: string,
   *   skipImageReuse?: boolean,
   * }} [options]
   */
  async function ensureImageReadyForDeploy(artifactDir, options = {}) {
    const imageRef = options.fullImage || fullImage;
    const latestRef = options.fullImage
      ? replaceDockerImageTag(options.fullImage, 'latest')
      : latestImage;
    const lastSlash = imageRef.lastIndexOf('/');
    const lastColon = imageRef.lastIndexOf(':');
    const effectiveTag =
      lastColon > lastSlash ? imageRef.slice(lastColon + 1) : 'latest';

    await dockerLogin();

    let reused = false;
    /** @type {string|null} */
    let registryPullFailure = null;
    if (!options.skipImageReuse) {
      // Normal deploy: prefer pipeline image (exact tag, then :latest retag).
      reused = await ensureImageFromPipeline(imageRef);
    } else if (await imageExistsLocally(imageRef)) {
      // Rollback: never retag :latest onto an older buildId, but DO use the
      // exact restored buildId image if it is already present locally.
      log.info(`Using restored image ${imageRef} (skipImageReuse — no :latest retag)`);
      reused = true;
    } else {
      const pulled = await tryPullImage(imageRef);
      if (pulled.ok) {
        reused = true;
      } else {
        registryPullFailure = pulled.reason;
        log.info(
          `${formatImageNotLocalAndPullFailed(imageRef, pulled.reason)} — attempting rebuild from artifact`
        );
      }
    }

    let ranCompose = false;

    if (!reused) {
      try {
        const result = await buildFromArtifactContents(artifactDir, imageRef);
        ranCompose = Boolean(result?.ranCompose);
      } catch (err) {
        if (registryPullFailure) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${formatImageNotLocalAndPullFailed(imageRef, registryPullFailure)}\n${detail}`
          );
        }
        throw err;
      }
    }

    if (ranCompose) {
      return { ranCompose: true, fullImage: imageRef };
    }

    if (!options.skipPush) {
      await maybePushImage(imageRef);
    }

    const dockerEnv = getDockerEnv();
    if (effectiveTag !== 'latest' && imageRef !== latestRef) {
      await execa('docker', ['tag', imageRef, latestRef], {
        stdio: 'pipe',
        env: dockerEnv,
      }).catch(() => {});
    }

    return { ranCompose: false, fullImage: imageRef };
  }

  return {
    fullImage,
    latestImage,
    imageTag,
    tagSource,
    getDockerEnv,
    hasRegistryCredentials,
    dockerLogin,
    maybePushImage,
    ensureImageFromPipeline,
    tryPullImage,
    buildFromArtifactContents,
    ensureImageReadyForDeploy,
  };
}

/**
 * Verify that an image:tag exists in a registry and is accessible with current credentials.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function checkImagePullability(config, env = process.env) {
  const { fullImage } = resolveDockerImageRef(config, env);
  const registryUser = env.DOCKER_REGISTRY_USERNAME || '';
  const registryToken = env.DOCKER_REGISTRY_TOKEN || '';
  const registryUrl = env.DOCKER_REGISTRY_URL || '';
  const dockerHost = env.DOCKER_HOST || '';

  /** @type {Record<string, string>} */
  const dockerEnv = { ...process.env };
  if (dockerHost) dockerEnv.DOCKER_HOST = dockerHost;
  if (env.DOCKER_TLS_VERIFY) dockerEnv.DOCKER_TLS_VERIFY = env.DOCKER_TLS_VERIFY;
  if (env.DOCKER_CERT_PATH) dockerEnv.DOCKER_CERT_PATH = env.DOCKER_CERT_PATH;

  if (registryUser && registryToken) {
    const registry = registryUrl || 'https://index.docker.io/v1/';
    try {
      await execa(
        'docker',
        ['login', registry, '-u', registryUser, '--password-stdin'],
        {
          input: registryToken,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: dockerEnv,
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message:
          `Image ${fullImage} is not pullable — registry login failed (${msg}). ` +
          'Check DOCKER_REGISTRY_USERNAME and DOCKER_REGISTRY_TOKEN.',
      };
    }
  }

  try {
    await execa('docker', ['manifest', 'inspect', fullImage], {
      stdio: 'pipe',
      env: dockerEnv,
    });
    return { ok: true, message: `Image ${fullImage} is pullable` };
  } catch (err) {
    const stderr =
      err instanceof Error && 'stderr' in err
        ? String(/** @type {{ stderr?: string }} */ (err).stderr || '')
        : '';
    const combined = `${err instanceof Error ? err.message : String(err)} ${stderr}`.toLowerCase();

    let hint = '';
    if (combined.includes('unauthorized') || combined.includes('authentication required')) {
      hint =
        'The image may exist but is private and inaccessible with your current credentials. ' +
        'Set DOCKER_REGISTRY_USERNAME and DOCKER_REGISTRY_TOKEN, or configure KUBE_IMAGE_PULL_SECRET for the cluster.';
    } else if (combined.includes('not found') || combined.includes('manifest unknown')) {
      hint =
        'The image does not exist in the registry yet.';
    } else if (combined.includes('denied')) {
      hint = 'Access denied — check registry credentials and repository permissions.';
    } else {
      hint = 'Verify the image name/tag and registry connectivity.';
    }

    const hasCreds = Boolean(registryUser && registryToken);

    return {
      ok: false,
      message:
        `Image ${fullImage} is not pullable. ${hint}\n` +
        (hasCreds
          ? '  DeployHub will build and push this image automatically during your next `deployhub build`.\n'
          : '  If you have DOCKER_REGISTRY_USERNAME/DOCKER_REGISTRY_TOKEN configured, DeployHub will build and push this image automatically during your next `deployhub build`.\n' +
            '  If not, either configure those variables, or push the image manually before deploying:\n') +
        `    docker push ${fullImage}`,
    };
  }
}
