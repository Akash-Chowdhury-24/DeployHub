import fs from 'fs-extra';
import path from 'path';
import archiver from 'archiver';
import { execa } from 'execa';
import { createLogger } from '../logger/index.js';
import { generateChecksums, formatChecksums } from '../utils/checksums.js';
import { getProjectVersion } from '../utils/version.js';
import { generateNginxConfig } from '../utils/nginx.js';
import { getGeneratedByMetadata, getArtifactReadmeFooter } from '../utils/author.js';

/**
 * @param {string} cwd
 * @returns {Promise<{ commit: string, branch: string }>}
 */
async function getGitInfo(cwd) {
  try {
    const { stdout: commit } = await execa('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
    });
    const { stdout: branch } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
    });
    return { commit: commit.trim(), branch: branch.trim() };
  } catch {
    return { commit: 'unknown', branch: 'unknown' };
  }
}

/**
 * @param {string} cwd
 * @param {number} [count]
 * @returns {Promise<string>}
 */
async function getReleaseNotes(cwd, count = 10) {
  try {
    const { stdout } = await execa(
      'git',
      ['log', `-${count}`, '--pretty=format:- %s (%h)'],
      { cwd }
    );
    return `# Release Notes\n\n${stdout}\n`;
  } catch {
    return '# Release Notes\n\nNo git history available.\n';
  }
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {'frontend'|'backend'}
 */
function resolveArtifactType(config) {
  if (config.projectType === 'both') return 'backend';
  return config.projectType === 'backend' ? 'backend' : 'frontend';
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {{ buildOutput: string, framework: string, startCommand: string|null, port: number, buildCommand: string|null }}
 */
function resolveBuildSettings(config) {
  if (config.projectType === 'both' && config.backend) {
    return {
      buildOutput: config.backend.buildOutput || '.',
      framework: config.backend.framework,
      startCommand: config.backend.startCommand || null,
      port: config.backend.port || 3000,
      buildCommand: config.backend.buildCommand ?? null,
    };
  }

  return {
    buildOutput: config.buildOutput || 'dist',
    framework: config.framework || 'node',
    startCommand: config.startCommand || null,
    port: config.port || 3000,
    buildCommand: config.buildCommand ?? null,
  };
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {{ buildOutput: string, framework: string }}
 */
function resolveFrontendSettings(config) {
  if (config.projectType === 'both' && config.frontend) {
    return {
      buildOutput: config.frontend.buildOutput || 'dist',
      framework: config.frontend.framework,
      buildCommand: config.frontend.buildCommand ?? null,
    };
  }

  return {
    buildOutput: config.buildOutput || 'dist',
    framework: config.framework || 'react',
    buildCommand: config.buildCommand ?? null,
  };
}

/**
 * @param {string} srcDir
 * @param {string} destDir
 * @param {string} label
 */
async function copyIfExists(srcDir, destDir, label) {
  const src = path.join(srcDir, label);
  if (await fs.pathExists(src)) {
    await fs.copy(src, path.join(destDir, label));
  }
}

/**
 * @param {string} cwd
 * @param {string} stagingDir
 * @param {string} dirName
 */
async function copyDirectoryIfExists(cwd, stagingDir, dirName) {
  const src = path.join(cwd, dirName);
  if (await fs.pathExists(src)) {
    await fs.copy(src, path.join(stagingDir, dirName));
  }
}

/**
 * @param {string} cwd
 * @param {string} stagingDir
 * @param {import('../core/config.js').DeployHubConfig} config
 */
async function stageFrontendArtifact(cwd, stagingDir, config) {
  const frontend = resolveFrontendSettings(config);
  const buildSrc = path.join(cwd, frontend.buildOutput);
  const outputName = path.basename(frontend.buildOutput) || 'dist';

  if (frontend.buildOutput === '.') {
    if (await fs.pathExists(path.join(cwd, 'index.html'))) {
      await fs.copy(path.join(cwd, 'index.html'), path.join(stagingDir, 'index.html'));
    }
  } else if (await fs.pathExists(buildSrc)) {
    await fs.copy(buildSrc, path.join(stagingDir, outputName));
  }

  for (const file of ['Dockerfile', 'docker-compose.yml', 'package.json', 'nginx.conf']) {
    await copyIfExists(cwd, stagingDir, file);
  }

  const hasSshDeploy = (config.deploy || []).some(
    (envName) => config.environments[envName]?.type === 'ssh'
  );

  if (hasSshDeploy && !fs.existsSync(path.join(stagingDir, 'nginx.conf'))) {
    const envName = config.deploy?.[0];
    const env = envName ? config.environments[envName] : null;
    const deployPath =
      env?.frontendDeployPath || env?.deployPath || env?.path || `/var/www/${config.project}`;
    const nginxConf = generateNginxConfig(config.project, deployPath, outputName);
    await fs.writeFile(path.join(stagingDir, 'nginx.conf'), nginxConf);
  }
}

/**
 * @param {string} cwd
 * @param {string} stagingDir
 * @param {import('../core/config.js').DeployHubConfig} config
 */
async function stageBackendArtifact(cwd, stagingDir, config) {
  const settings = resolveBuildSettings(config);
  const framework = settings.framework;

  await copyDirectoryIfExists(cwd, stagingDir, 'src');

  for (const file of ['Dockerfile', 'docker-compose.yml', '.env.example']) {
    await copyIfExists(cwd, stagingDir, file);
  }

  await copyDirectoryIfExists(cwd, stagingDir, 'config');
  await copyDirectoryIfExists(cwd, stagingDir, 'migrations');

  if (['express', 'nestjs', 'fastify', 'koa', 'nextjs'].includes(framework)) {
    await copyIfExists(cwd, stagingDir, 'package.json');
  } else if (['fastapi', 'django', 'flask'].includes(framework)) {
    await copyIfExists(cwd, stagingDir, 'requirements.txt');
    if (framework === 'django' && (await fs.pathExists(path.join(cwd, 'manage.py')))) {
      await copyIfExists(cwd, stagingDir, 'manage.py');
    }
  } else if (['laravel', 'symfony'].includes(framework)) {
    await copyIfExists(cwd, stagingDir, 'composer.json');
    await copyIfExists(cwd, stagingDir, 'composer.lock');
  } else if (framework === 'spring') {
    await copyIfExists(cwd, stagingDir, 'pom.xml');
    const targetDir = path.join(cwd, 'target');
    if (await fs.pathExists(targetDir)) {
      await fs.ensureDir(path.join(stagingDir, 'target'));
      const jars = (await fs.readdir(targetDir)).filter((f) => f.endsWith('.jar'));
      for (const jar of jars) {
        await fs.copy(path.join(targetDir, jar), path.join(stagingDir, 'target', jar));
      }
    }
  } else if (framework === 'go') {
    await copyIfExists(cwd, stagingDir, 'go.mod');
    await copyIfExists(cwd, stagingDir, 'go.sum');
    await copyDirectoryIfExists(cwd, stagingDir, 'bin');
  } else if (framework === 'dotnet') {
    const files = await fs.readdir(cwd);
    for (const f of files.filter((name) => name.endsWith('.csproj'))) {
      await copyIfExists(cwd, stagingDir, f);
    }
    await copyDirectoryIfExists(cwd, stagingDir, settings.buildOutput || 'publish');
  } else if (framework === 'rails') {
    await copyIfExists(cwd, stagingDir, 'Gemfile');
    await copyIfExists(cwd, stagingDir, 'Gemfile.lock');
    await copyIfExists(cwd, stagingDir, 'config.ru');
  } else {
    await copyIfExists(cwd, stagingDir, 'package.json');
    await copyIfExists(cwd, stagingDir, 'requirements.txt');
  }

  if (settings.buildOutput && settings.buildOutput !== '.' && settings.buildOutput !== 'src') {
    const built = path.join(cwd, settings.buildOutput);
    if (await fs.pathExists(built) && !['target', 'bin', 'publish'].includes(settings.buildOutput)) {
      await fs.copy(built, path.join(stagingDir, settings.buildOutput));
    }
  }
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} [cwd]
 * @returns {string}
 */
export function getArtifactDir(config, cwd = process.cwd()) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(
    cwd,
    'artifact',
    config.project,
    date,
    `v${config.version}`
  );
}

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string[]} [deployedTargets]
 * @param {string} [cwd]
 * @returns {Promise<{ artifactDir: string, zipPath: string }>}
 */
export async function createArtifact(config, deployedTargets = [], cwd = process.cwd()) {
  const log = createLogger('artifact');
  const version = config.version || (await getProjectVersion(cwd));
  config.version = version;

  const artifactDir = getArtifactDir(config, cwd);
  const stagingDir = path.join(artifactDir, '_staging');
  await fs.emptyDir(stagingDir);

  const projectType = config.projectType || 'frontend';
  const artifactType = resolveArtifactType(config);
  const settings = resolveBuildSettings(config);

  log.info(`Staging ${projectType} artifact...`);

  if (projectType === 'both') {
    await stageFrontendArtifact(cwd, stagingDir, config);
    const backendStaging = path.join(stagingDir, 'backend');
    await fs.ensureDir(backendStaging);
    await stageBackendArtifact(cwd, backendStaging, config);
  } else if (artifactType === 'backend') {
    await stageBackendArtifact(cwd, stagingDir, config);
  } else {
    await stageFrontendArtifact(cwd, stagingDir, config);
  }

  const git = await getGitInfo(cwd);
  const environment = process.env.DEPLOYHUB_ENV || 'production';
  const timestamp = new Date().toISOString();

  const metadata = {
    project: config.project,
    version,
    timestamp,
    gitCommit: git.commit,
    branch: git.branch,
    environment,
    projectType: artifactType,
    framework: settings.framework,
    buildOutput: settings.buildOutput,
    startCommand: settings.startCommand,
    port: settings.port,
    generatedBy: getGeneratedByMetadata(),
  };

  if (projectType === 'both') {
    const frontend = resolveFrontendSettings(config);
    metadata.projectType = 'both';
    metadata.frontend = frontend;
    metadata.backend = {
      framework: settings.framework,
      startCommand: settings.startCommand,
      port: settings.port,
    };
  }

  const readme = `# ${config.project} Artifact v${version}

This artifact was created by DeployHub on ${timestamp}.
Project type: ${projectType}

## Manual Re-deployment

1. Extract \`artifact.zip\`
2. Copy files to your server
3. Follow framework-specific start instructions in deployment.json

No other tooling required — everything needed is in this archive.

${getArtifactReadmeFooter()}`;

  await fs.writeFile(path.join(stagingDir, 'README.md'), readme);
  await fs.writeJson(path.join(stagingDir, 'metadata.json'), metadata, { spaces: 2 });
  await fs.writeJson(path.join(artifactDir, 'metadata.json'), metadata, { spaces: 2 });
  await fs.writeFile(
    path.join(artifactDir, 'release-notes.md'),
    await getReleaseNotes(cwd)
  );
  await fs.writeFile(path.join(artifactDir, 'README.md'), readme);
  await fs.writeJson(
    path.join(artifactDir, 'deployment.json'),
    { targets: deployedTargets, deployedAt: timestamp },
    { spaces: 2 }
  );

  const logsContent = `[${timestamp}] Artifact created for ${config.project} v${version} (${projectType})\n`;
  await fs.writeFile(path.join(artifactDir, 'logs.txt'), logsContent);
  await fs.writeFile(path.join(stagingDir, 'logs.txt'), logsContent);

  log.info('Creating zip archive...');
  const zipPath = path.join(artifactDir, 'artifact.zip');
  await createZip(stagingDir, zipPath);

  const checksums = await generateChecksums(stagingDir);
  const checksumContent = formatChecksums(checksums);
  await fs.writeFile(path.join(artifactDir, 'checksums.txt'), checksumContent);
  await fs.writeFile(path.join(stagingDir, 'checksums.txt'), checksumContent);
  await fs.writeJson(
    path.join(stagingDir, 'deployment.json'),
    { targets: deployedTargets, deployedAt: timestamp },
    { spaces: 2 }
  );
  await fs.writeFile(
    path.join(stagingDir, 'release-notes.md'),
    await getReleaseNotes(cwd)
  );

  await fs.remove(stagingDir);
  log.success(`Artifact created at ${artifactDir}`);

  return { artifactDir, zipPath };
}

/**
 * @param {string} sourceDir
 * @param {string} zipPath
 */
function createZip(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * @param {string} [cwd]
 * @returns {Promise<Array<{ project: string, date: string, version: string, path: string, size: number }>>}
 */
export async function listLocalArtifacts(cwd = process.cwd()) {
  const artifactRoot = path.join(cwd, 'artifact');
  if (!(await fs.pathExists(artifactRoot))) return [];

  /** @type {Array<{ project: string, date: string, version: string, path: string, size: number }>} */
  const results = [];

  const projects = await fs.readdir(artifactRoot);
  for (const project of projects) {
    const projectDir = path.join(artifactRoot, project);
    if (!(await fs.stat(projectDir)).isDirectory()) continue;

    const dates = await fs.readdir(projectDir);
    for (const date of dates) {
      const dateDir = path.join(projectDir, date);
      if (!(await fs.stat(dateDir)).isDirectory()) continue;

      const versions = await fs.readdir(dateDir);
      for (const version of versions) {
        const versionDir = path.join(dateDir, version);
        const zipPath = path.join(versionDir, 'artifact.zip');
        if (await fs.pathExists(zipPath)) {
          const stat = await fs.stat(zipPath);
          results.push({
            project,
            date,
            version: version.replace(/^v/, ''),
            path: versionDir,
            size: stat.size,
          });
        }
      }
    }
  }

  return results.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * @param {string} versionDir
 * @param {string} extractTo
 */
export async function extractArtifact(versionDir, extractTo) {
  const zipPath = path.join(versionDir, 'artifact.zip');
  if (!(await fs.pathExists(zipPath))) {
    throw new Error(`Artifact zip not found at ${zipPath}`);
  }
  await fs.ensureDir(extractTo);
  const { execa: execaFn } = await import('execa');
  if (process.platform === 'win32') {
    await execaFn(
      'powershell',
      ['-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractTo}" -Force`],
      { stdio: 'inherit' }
    );
  } else {
    await execaFn('unzip', ['-o', zipPath, '-d', extractTo], { stdio: 'inherit' });
  }
}

/**
 * Rebuild artifact.zip after deploy so deployment.json is included for remote rollback.
 * @param {string} artifactDir
 */
export async function repackArtifactZip(artifactDir) {
  const zipPath = path.join(artifactDir, 'artifact.zip');
  if (!(await fs.pathExists(zipPath))) {
    throw new Error(`Artifact zip not found at ${zipPath}`);
  }

  const tempDir = path.join(artifactDir, '_repack');
  await fs.emptyDir(tempDir);
  await extractArtifact(artifactDir, tempDir);

  const deploymentPath = path.join(artifactDir, 'deployment.json');
  if (await fs.pathExists(deploymentPath)) {
    await fs.copy(deploymentPath, path.join(tempDir, 'deployment.json'));
  }

  for (const file of ['metadata.json', 'logs.txt', 'checksums.txt', 'release-notes.md', 'README.md']) {
    const src = path.join(artifactDir, file);
    if (await fs.pathExists(src)) {
      await fs.copy(src, path.join(tempDir, file));
    }
  }

  await fs.remove(zipPath);
  await createZip(tempDir, zipPath);
  await fs.remove(tempDir);
}

export default { createArtifact, listLocalArtifacts, extractArtifact, getArtifactDir, repackArtifactZip };
