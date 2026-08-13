/**
 * Proof that the Laravel multi-stage Dockerfile survives Composer scripts that
 * require app source (artisan) — the bug that plain smoke-php-dockerfile missed.
 *
 * Fixture mirrors Laravel's composer.json post-autoload-dump without downloading
 * the full framework: vendor stage only has composer.json/lock, so a scripted
 * `composer install` fails with "Could not open input file: artisan" unless
 * --no-scripts is used there and dump-autoload runs after COPY . .
 *
 * Usage: node scripts/dev/smoke-php-laravel-dockerfile.mjs
 * Requires a running Docker daemon. Not part of the Jest suite.
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execa } from 'execa';
import { generateDockerfile } from '../../src/utils/dockerfile.js';
import {
  DEFAULT_PHP_VERSION,
  resolvePhpVersion,
} from '../../src/utils/php-version.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-php-laravel-df-'));
const tag = 'deployhub-php-smoke-laravel-scripts:local';
const hostPort = 18082;

/** Fixture pins the same key CI/Dockerfile share — regression if FROM drifts. */
const fixturePhpVersion = DEFAULT_PHP_VERSION;

const config = {
  projectType: 'backend',
  framework: 'laravel',
  language: 'php',
  port: 8080,
  phpVersion: fixturePhpVersion,
};

const dockerfile = generateDockerfile(config);
const expectedFrom = `FROM php:${resolvePhpVersion(config)}-cli-alpine`;

if (!dockerfile.includes(expectedFrom)) {
  throw new Error(
    `Generated Dockerfile missing runtime base "${expectedFrom}".\n` +
      `Got FROM lines:\n${dockerfile
        .split('\n')
        .filter((l) => l.startsWith('FROM '))
        .join('\n')}`
  );
}
if (/FROM php:8\.2-cli-alpine/.test(dockerfile)) {
  throw new Error(
    'Generated Dockerfile still hardcodes php:8.2-cli-alpine (stale base image)'
  );
}
console.log(`OK: runtime stage uses ${expectedFrom} (phpVersion=${fixturePhpVersion})`);

await fs.writeFile(path.join(tmp, 'Dockerfile'), dockerfile);
await fs.writeFile(
  path.join(tmp, '.dockerignore'),
  ['vendor', '.git', 'node_modules'].join('\n') + '\n'
);

// Laravel-shaped composer.json: post-autoload-dump needs artisan (exact failure mode).
await fs.writeJson(
  path.join(tmp, 'composer.json'),
  {
    name: 'demo/laravel-smoke',
    description: 'Minimal Laravel-shaped fixture for Dockerfile smoke',
    type: 'project',
    require: {
      php: '>=8.4.1',
    },
    autoload: {
      'psr-4': {
        'App\\': 'app/',
      },
    },
    scripts: {
      'post-autoload-dump': [
        '@php artisan package:discover --ansi',
      ],
    },
    config: {
      'optimize-autoloader': true,
    },
  },
  { spaces: 2 }
);

// Empty lock so Composer does not try to resolve a remote package set.
await fs.writeJson(
  path.join(tmp, 'composer.lock'),
  {
    _readme: ['Laravel Dockerfile smoke lock'],
    'content-hash': 'deployhub-laravel-dockerfile-smoke',
    packages: [],
    'packages-dev': [],
    aliases: [],
    'minimum-stability': 'stable',
    'stability-flags': [],
    'prefer-stable': true,
    'prefer-lowest': false,
    platform: {},
    'platform-dev': {},
    'plugin-api-version': '2.6.0',
  },
  { spaces: 2 }
);

// Real artisan entrypoint: package:discover must succeed during final dump-autoload.
await fs.writeFile(
  path.join(tmp, 'artisan'),
  `#!/usr/bin/env php
<?php
// Minimal stand-in for Laravel's artisan used only by Dockerfile smoke tests.
$argv = $_SERVER['argv'] ?? [];
$cmd = $argv[1] ?? '';
if ($cmd === 'package:discover' || ($argv[2] ?? '') === 'package:discover') {
    fwrite(STDOUT, "package:discover ok\\n");
    exit(0);
}
if ($cmd === 'serve') {
    // php artisan serve --host=0.0.0.0 --port=8080
    $host = '0.0.0.0';
    $port = '8080';
    foreach ($argv as $i => $arg) {
        if (str_starts_with($arg, '--host=')) $host = substr($arg, 7);
        if (str_starts_with($arg, '--port=')) $port = substr($arg, 7);
    }
    $docroot = is_dir(__DIR__ . '/public') ? __DIR__ . '/public' : __DIR__;
    passthru('php -S ' . escapeshellarg($host . ':' . $port) . ' -t ' . escapeshellarg($docroot));
    exit(0);
}
fwrite(STDERR, "artisan stub: unknown command\\n");
exit(1);
`
);

await fs.ensureDir(path.join(tmp, 'app'));
await fs.ensureDir(path.join(tmp, 'storage'));
await fs.ensureDir(path.join(tmp, 'bootstrap/cache'));
await fs.ensureDir(path.join(tmp, 'public'));
await fs.writeFile(
  path.join(tmp, 'public', 'index.php'),
  '<?php http_response_code(200); echo "ok-laravel-vendor-scripts";'
);

console.log('WORKDIR', tmp);
console.log('--- Dockerfile (vendor stage must use --no-scripts) ---');
console.log(dockerfile);

if (!dockerfile.includes('--no-scripts')) {
  throw new Error('Generated Dockerfile missing --no-scripts on vendor composer install');
}
if (!dockerfile.includes('composer dump-autoload')) {
  throw new Error('Generated Dockerfile missing final-stage composer dump-autoload');
}

console.log('\nBuilding (exercises vendor stage + post-autoload-dump)...');
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

try {
  await new Promise((r) => setTimeout(r, 2500));
  const { stdout } = await execa('curl', ['-fsS', `http://127.0.0.1:${hostPort}/`]);
  console.log('HTTP body:', stdout);
  if (!stdout.includes('ok-laravel-vendor-scripts')) {
    throw new Error(`Unexpected response: ${stdout}`);
  }
  console.log(
    'PASS: Laravel multi-stage build survived post-autoload-dump and served HTTP'
  );
} finally {
  await execa('docker', ['rm', '-f', id]).catch(() => {});
}
