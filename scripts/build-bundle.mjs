#!/usr/bin/env node
/**
 * Bundle DeployHub for pkg binary distribution.
 */
import * as esbuild from 'esbuild';
import fs from 'fs-extra';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const outFile = path.join(root, 'dist', 'deployhub.cjs');

const pkgJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));

await fs.ensureDir(path.join(root, 'dist'));

await esbuild.build({
  entryPoints: [path.join(root, 'src/cli/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: outFile,
  banner: {
    js: 'const import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    __DEPLOYHUB_VERSION__: JSON.stringify(pkgJson.version),
    'import.meta.url': 'import_meta_url',
  },
  external: ['ssh2', 'cpu-features'],
  logLevel: 'info',
});

console.log(`Bundle written to ${outFile}`);
