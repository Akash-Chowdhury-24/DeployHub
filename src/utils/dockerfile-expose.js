import fs from 'fs-extra';
import path from 'path';

/** Static SPA frameworks that use nginx:alpine + EXPOSE 80 in generated Dockerfiles. */
const STATIC_FRONTEND_FRAMEWORKS = new Set([
  'react',
  'vue',
  'angular',
  'svelte',
  'astro',
  'vanilla',
]);

/**
 * Parse the listening port from Dockerfile EXPOSE instructions.
 * Uses the last EXPOSE line (final stage in multi-stage builds).
 * Supports `EXPOSE 80`, `EXPOSE 80/tcp`, and multi-port lines (first numeric wins on that line).
 *
 * @param {string} content
 * @returns {number|null}
 */
export function parseDockerfileExposePort(content) {
  if (!content || typeof content !== 'string') return null;

  /** @type {number|null} */
  let lastPort = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^EXPOSE\s+(.+)$/i);
    if (!match) continue;

    const tokens = match[1].trim().split(/\s+/);
    for (const token of tokens) {
      const portToken = token.split('/')[0];
      if (!/^\d+$/.test(portToken)) continue;
      const port = Number(portToken);
      if (port >= 1 && port <= 65535) {
        lastPort = port;
        break;
      }
    }
  }

  return lastPort;
}

/**
 * Per-type fallback matching generated Dockerfile templates when EXPOSE is unavailable.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {number}
 */
export function resolveFallbackContainerPort(config) {
  const projectType = config.projectType || 'frontend';
  const framework =
    (projectType === 'both'
      ? config.backend?.framework || config.framework
      : config.framework) ||
    (projectType === 'frontend' ? 'react' : 'express');

  if (projectType === 'frontend' && STATIC_FRONTEND_FRAMEWORKS.has(framework)) {
    return 80;
  }

  if (['laravel', 'symfony', 'php'].includes(framework)) return 80;
  if (['fastapi', 'django', 'flask', 'python'].includes(framework)) return 8000;
  if (['spring', 'java'].includes(framework)) return 8080;
  if (framework === 'go') return 8080;
  if (framework === 'dotnet') return 5000;
  if (framework === 'rails') return 3000;
  if (framework === 'ruby') return 9292;

  // nextjs, nestjs, express, and other Node backends
  return 3000;
}

/**
 * Precedence: Dockerfile EXPOSE → config.port / backend.port → per-type fallback.
 *
 * @param {string} cwd
 * @param {import('../core/config.js').DeployHubConfig} config
 * @returns {Promise<{ port: number, source: 'expose'|'config'|'fallback' }>}
 */
export async function resolveContainerPort(cwd, config) {
  const dockerfilePath = path.join(cwd, 'Dockerfile');
  if (await fs.pathExists(dockerfilePath)) {
    try {
      const content = await fs.readFile(dockerfilePath, 'utf8');
      const exposed = parseDockerfileExposePort(content);
      if (exposed != null) {
        return { port: exposed, source: 'expose' };
      }
    } catch {
      // treat as unparseable / unreadable → continue
    }
  }

  if (config.projectType === 'both' && config.backend?.port) {
    return { port: Number(config.backend.port), source: 'config' };
  }
  if (config.port) {
    return { port: Number(config.port), source: 'config' };
  }
  if (config.backend?.port) {
    return { port: Number(config.backend.port), source: 'config' };
  }

  return { port: resolveFallbackContainerPort(config), source: 'fallback' };
}

export default {
  parseDockerfileExposePort,
  resolveFallbackContainerPort,
  resolveContainerPort,
};
