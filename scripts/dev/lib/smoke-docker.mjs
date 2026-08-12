/**
 * Shared helpers for scripts/dev/smoke-*-dockerfile.mjs
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execa } from 'execa';
import { generateDockerfile } from '../../../src/utils/dockerfile.js';

/**
 * @param {{
 *   framework: string,
 *   port?: number,
 *   hostPort: number,
 *   expectBody: string,
 *   config?: Record<string, unknown>,
 *   setup: (tmp: string) => Promise<void>,
 *   readinessMs?: number,
 * }} opts
 */
export async function smokeDockerfile(opts) {
  const {
    framework,
    port = 8080,
    hostPort,
    expectBody,
    config = {},
    setup,
    readinessMs = 2500,
  } = opts;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `dh-df-${framework}-`));
  const tag = `deployhub-smoke-${framework}:local`;

  const dockerfile = generateDockerfile({
    projectType: config.projectType || 'backend',
    framework,
    port,
    ...config,
  });

  await setup(tmp);
  await fs.writeFile(path.join(tmp, 'Dockerfile'), dockerfile);
  if (!(await fs.pathExists(path.join(tmp, '.dockerignore')))) {
    await fs.writeFile(path.join(tmp, '.dockerignore'), '.git\n');
  }

  console.log('framework', framework);
  console.log('WORKDIR', tmp);
  console.log('--- Dockerfile ---');
  console.log(dockerfile);
  console.log('\nBuilding...');
  await execa('docker', ['build', '-t', tag, '.'], { cwd: tmp, stdio: 'inherit' });

  console.log('\nRunning...');
  const { stdout: cid } = await execa('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    `${hostPort}:${port}`,
    tag,
  ]);
  const id = cid.trim();
  console.log('container', id);

  try {
    await new Promise((r) => setTimeout(r, readinessMs));
    let stdout = '';
    let lastErr;
    for (let i = 0; i < 10; i++) {
      try {
        const res = await execa('curl', ['-fsS', `http://127.0.0.1:${hostPort}/`]);
        stdout = res.stdout;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!stdout) {
      const logs = await execa('docker', ['logs', id], { reject: false });
      console.error('docker logs:\n', logs.stdout, logs.stderr);
      throw lastErr || new Error('curl failed');
    }
    console.log('HTTP body:', stdout);
    if (!stdout.includes(expectBody)) {
      throw new Error(`Unexpected response: ${stdout}`);
    }
    console.log(`PASS: ${framework} container served HTTP on EXPOSE port`);
  } finally {
    await execa('docker', ['rm', '-f', id]).catch(() => {});
  }
}

export { generateDockerfile, fs, path, execa };
