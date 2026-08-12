/**
 * One-shot proof: build+run a generated PHP Dockerfile and curl it.
 * Usage: node scripts/dev/smoke-php-dockerfile.mjs [symfony|php]
 * Not part of the Jest suite — requires a running Docker daemon.
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execa } from 'execa';
import { generateDockerfile } from '../../src/utils/dockerfile.js';

const framework = process.argv[2] || 'symfony';
if (!['symfony', 'php', 'laravel'].includes(framework)) {
  console.error(`Unsupported framework: ${framework}`);
  process.exit(1);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `dh-php-df-${framework}-`));
const tag = `deployhub-php-smoke-${framework}:local`;
const hostPort = framework === 'php' ? 18081 : 18080;
const dockerfile = generateDockerfile({
  projectType: 'backend',
  framework,
  port: 8080,
});

await fs.writeFile(path.join(tmp, 'Dockerfile'), dockerfile);

if (framework === 'php') {
  // Plain PHP, no composer.json — index at project root.
  await fs.writeFile(
    path.join(tmp, 'index.php'),
    '<?php http_response_code(200); echo "ok-plain-php";'
  );
} else {
  await fs.writeFile(
    path.join(tmp, 'composer.json'),
    JSON.stringify({ name: 'demo/app', require: {} })
  );
  await fs.writeFile(
    path.join(tmp, 'composer.lock'),
    JSON.stringify({
      packages: [],
      'packages-dev': [],
      'content-hash': 'x',
      platform: {},
    })
  );
  if (framework === 'laravel') {
    await fs.writeFile(
      path.join(tmp, 'artisan'),
      "#!/usr/bin/env php\n<?php echo 'artisan stub';\n"
    );
    await fs.ensureDir(path.join(tmp, 'storage'));
    await fs.ensureDir(path.join(tmp, 'bootstrap/cache'));
  }
  await fs.ensureDir(path.join(tmp, 'public'));
  await fs.writeFile(
    path.join(tmp, 'public', 'index.php'),
    '<?php http_response_code(200); echo "ok-php-k8s";'
  );
}

await fs.writeFile(path.join(tmp, '.dockerignore'), 'vendor\n.git\n');

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
  `${hostPort}:8080`,
  tag,
]);
const id = cid.trim();
console.log('container', id);

const expectBody = framework === 'php' ? 'ok-plain-php' : 'ok-php-k8s';

try {
  await new Promise((r) => setTimeout(r, 2000));
  const { stdout } = await execa('curl', ['-fsS', `http://127.0.0.1:${hostPort}/`]);
  console.log('HTTP body:', stdout);
  if (!stdout.includes(expectBody)) {
    throw new Error(`Unexpected response: ${stdout}`);
  }
  console.log(`PASS: ${framework} PHP container served HTTP on EXPOSE port`);
} finally {
  await execa('docker', ['rm', '-f', id]).catch(() => {});
}
