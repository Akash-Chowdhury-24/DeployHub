#!/usr/bin/env node
/**
 * Fail early if esbuild bundle inputs under src/ are not tracked by git.
 * Catches stale imports after renames (e.g. src/rollback → src/utils/rollback).
 */
import * as esbuild from 'esbuild';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src/cli/index.js');

/** @type {Set<string>} */
const tracked = new Set(
  execSync('git ls-files', { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
);

let result;
try {
  result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    write: false,
    metafile: true,
    external: ['ssh2', 'cpu-features'],
    logLevel: 'silent',
  });
} catch (err) {
  console.error('ERROR: esbuild could not resolve the bundle graph (missing import or syntax error).');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/** @type {string[]} */
const untracked = [];

for (const inputPath of Object.keys(result.metafile.inputs)) {
  const rel = path.relative(root, inputPath).replace(/\\/g, '/');
  if (!rel.startsWith('src/')) continue;
  if (!tracked.has(rel)) {
    untracked.push(rel);
  }
}

if (untracked.length > 0) {
  console.error('ERROR: esbuild bundle depends on src/ files not tracked by git:\n');
  for (const file of untracked.sort()) {
    console.error(`  - ${file}`);
  }
  console.error('\nAdd them with git add, or fix stale import paths.');
  process.exit(1);
}

console.log(`Bundle source check OK (${Object.keys(result.metafile.inputs).length} inputs, all src/ files tracked).`);
