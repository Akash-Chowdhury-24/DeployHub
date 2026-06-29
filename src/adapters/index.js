import nodeAdapter from './node.adapter.js';
import pythonAdapter from './python.adapter.js';
import phpAdapter from './php.adapter.js';
import javaAdapter from './java.adapter.js';
import goAdapter from './go.adapter.js';
import dotnetAdapter from './dotnet.adapter.js';
import railsAdapter from './rails.adapter.js';

/** @type {Record<string, import('./node.adapter.js').default>} */
const ADAPTERS = {
  react: nodeAdapter,
  vue: nodeAdapter,
  angular: nodeAdapter,
  nextjs: nodeAdapter,
  svelte: nodeAdapter,
  astro: nodeAdapter,
  vanilla: nodeAdapter,
  node: nodeAdapter,
  express: nodeAdapter,
  nestjs: nodeAdapter,
  fastify: nodeAdapter,
  koa: nodeAdapter,
  python: pythonAdapter,
  fastapi: pythonAdapter,
  django: pythonAdapter,
  flask: pythonAdapter,
  php: phpAdapter,
  laravel: phpAdapter,
  symfony: phpAdapter,
  java: javaAdapter,
  spring: javaAdapter,
  go: goAdapter,
  dotnet: dotnetAdapter,
  rails: railsAdapter,
};

/**
 * @param {string} framework
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string} [cwd]
 * @returns {import('./node.adapter.js').default}
 */
export function getAdapter(framework, config, cwd = process.cwd()) {
  const AdapterClass = ADAPTERS[framework] || nodeAdapter;
  return AdapterClass.create(config, cwd);
}

export default { getAdapter };
