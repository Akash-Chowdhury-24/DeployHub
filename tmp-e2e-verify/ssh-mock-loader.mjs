import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-node-ssh.mjs')
).href;

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === 'node-ssh' ||
    specifier.includes('node-ssh') && !specifier.includes('fake-node-ssh')
  ) {
    return { shortCircuit: true, url: fake };
  }
  return nextResolve(specifier, context);
}
