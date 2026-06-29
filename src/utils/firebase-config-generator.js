/**
 * Generate firebase.json for Firebase Hosting if missing.
 *
 * @param {string} buildOutput
 * @returns {object}
 */
export function generateFirebaseHostingConfig(buildOutput = 'dist') {
  return {
    hosting: {
      public: buildOutput,
      ignore: ['firebase.json', '**/.*', '**/node_modules/**'],
      rewrites: [{ source: '**', destination: '/index.html' }],
    },
  };
}

/**
 * @param {string} buildOutput
 * @param {string} [cwd]
 */
export async function ensureFirebaseJson(buildOutput = 'dist', cwd = process.cwd()) {
  const fs = (await import('fs-extra')).default;
  const path = (await import('path')).default;
  const firebasePath = path.join(cwd, 'firebase.json');

  if (await fs.pathExists(firebasePath)) {
    return firebasePath;
  }

  const config = generateFirebaseHostingConfig(buildOutput);
  await fs.writeJson(firebasePath, config, { spaces: 2 });
  return firebasePath;
}

export default { generateFirebaseHostingConfig, ensureFirebaseJson };
