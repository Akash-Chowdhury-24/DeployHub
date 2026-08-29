import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createArtifact, extractArtifact } from '../src/artifact/engine.js';
import { generateDockerfile } from '../src/utils/dockerfile.js';
import { generateWorkflowYaml } from '../src/utils/github-actions.js';

function backendConfig(framework, extra = {}) {
  return {
    project: `pack-${framework}`,
    version: '1.0.0',
    buildId: `pack-${framework}-1`,
    projectType: 'backend',
    framework,
    buildCommand: extra.buildCommand ?? null,
    buildOutput: extra.buildOutput ?? '.',
    startCommand: extra.startCommand || 'start',
    port: extra.port || 3000,
    storage: ['local'],
    pipeline: { build: true, deploy: false },
    environments: {
      production: {
        enabled: true,
        method: 'ssh',
        trigger: 'manual',
        config: { host: '10.0.0.1', user: 'ubuntu', deployPath: '/var/www/app' },
      },
    },
    defaultEnvironment: 'production',
    ...extra.config,
  };
}

describe('backend artifact packs root entrypoints', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-pack-'));
  });

  afterEach(async () => {
    await fs.remove(tmp).catch(() => {});
  });

  test.each([
    ['express', 'server.js'],
    ['fastify', 'app.js'],
    ['koa', 'index.js'],
    ['node', 'main.js'],
  ])('%s packs root %s (not just package.json)', async (framework, entry) => {
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: framework,
      version: '1.0.0',
      scripts: { start: `node ${entry}` },
    });
    await fs.writeFile(path.join(tmp, entry), `console.log('${framework}')\n`);

    const { artifactDir } = await createArtifact(backendConfig(framework), [], tmp);
    const out = path.join(tmp, '_out');
    await extractArtifact(artifactDir, out);
    expect(await fs.pathExists(path.join(out, entry))).toBe(true);
    expect(await fs.pathExists(path.join(out, 'package.json'))).toBe(true);
  });

  test('go packs main.go and bin/app', async () => {
    await fs.writeFile(path.join(tmp, 'go.mod'), 'module demo\ngo 1.22\n');
    await fs.writeFile(path.join(tmp, 'main.go'), 'package main\nfunc main() {}\n');
    await fs.ensureDir(path.join(tmp, 'bin'));
    await fs.writeFile(path.join(tmp, 'bin', 'app'), 'binary\n');

    const { artifactDir } = await createArtifact(
      backendConfig('go', { buildOutput: 'bin', buildCommand: 'go build -o bin/app .' }),
      [],
      tmp
    );
    const out = path.join(tmp, '_out');
    await extractArtifact(artifactDir, out);
    expect(await fs.pathExists(path.join(out, 'main.go'))).toBe(true);
    expect(await fs.pathExists(path.join(out, 'bin', 'app'))).toBe(true);
    expect(await fs.pathExists(path.join(out, 'go.mod'))).toBe(true);
  });
});

describe('generator fixes from verification sweep', () => {
  test('vanilla Dockerfile does not invent npm run build', () => {
    const df = generateDockerfile({
      projectType: 'frontend',
      framework: 'vanilla',
      buildCommand: null,
      buildOutput: '.',
    });
    expect(df).toContain('FROM nginx:alpine');
    expect(df).not.toContain('npm run build');
    expect(df).not.toContain('npm ci');
    expect(df).toContain('COPY . /usr/share/nginx/html');
  });

  test('fullstack PHP+React CI installs npm AND composer', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['production'],
      { production: { method: 'ssh' } },
      'npm:@akash-chowdhury-24/deployhub',
      {
        projectType: 'both',
        frontend: { framework: 'react', buildCommand: 'npm run build', buildOutput: 'dist' },
        backend: { framework: 'laravel', language: 'php' },
        framework: 'laravel',
      }
    );
    expect(yaml).toContain('npm install && composer install --no-interaction');
    expect(yaml).toContain('setup-php');
  });

  test('.NET generated Dockerfile does not hardcode App.dll', () => {
    const df = generateDockerfile({
      projectType: 'backend',
      framework: 'dotnet',
      port: 5000,
    });
    expect(df).not.toContain('CMD ["dotnet", "App.dll"]');
    expect(df).toContain('ls *.dll');
  });
});
