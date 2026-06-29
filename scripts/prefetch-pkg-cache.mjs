#!/usr/bin/env node
/**
 * Prefetch pkg base binaries into the local cache.
 * @yao-pkg/pkg-fetch 3.6.x looks under tag v3.6, but node20 bases are published on v3.5.
 */
import { mkdir, access, chmod } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import os from 'os';

const DOWNLOAD_TAG = 'v3.5';
const CACHE_TAG = 'v3.6';
const NODE_VERSION = 'v20.20.2';
// All node20.20.2 bases on pkg-fetch v3.5 — needed for cross-compile on ubuntu-latest
const BASES = [
  `${NODE_VERSION}-alpine-arm64`,
  `${NODE_VERSION}-alpine-x64`,
  `${NODE_VERSION}-linux-arm64`,
  `${NODE_VERSION}-linux-x64`,
  `${NODE_VERSION}-linuxstatic-arm64`,
  `${NODE_VERSION}-linuxstatic-armv7`,
  `${NODE_VERSION}-linuxstatic-x64`,
  `${NODE_VERSION}-macos-arm64`,
  `${NODE_VERSION}-macos-x64`,
  `${NODE_VERSION}-win-arm64`,
  `${NODE_VERSION}-win-x64`,
];

const cacheRoot =
  process.env.PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache');
const cacheDir = path.join(cacheRoot, CACHE_TAG);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function download(name) {
  const remoteName = `node-${name}`;
  const dest = path.join(cacheDir, `fetched-${name}`);
  if (await exists(dest)) {
    console.log(`  cached  fetched-${name}`);
    return;
  }

  const url = `https://github.com/yao-pkg/pkg-fetch/releases/download/${DOWNLOAD_TAG}/${remoteName}`;
  console.log(`  fetch   fetched-${name}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  await pipeline(response.body, createWriteStream(dest));
  if (!name.includes('-win-')) {
    await chmod(dest, 0o755);
  }
}

await mkdir(cacheDir, { recursive: true });
console.log(`Prefetching pkg bases into ${cacheDir}`);
for (const base of BASES) {
  await download(base);
}
console.log('Prefetch complete.');
