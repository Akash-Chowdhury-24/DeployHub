import { smokeDockerfile, fs, path, execa } from './lib/smoke-docker.mjs';

await smokeDockerfile({
  framework: 'react',
  port: 80,
  hostPort: 18080,
  expectBody: 'ok-frontend',
  config: {
    projectType: 'frontend',
    buildCommand: 'npm run build',
    buildOutput: 'dist',
  },
  setup: async (tmp) => {
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'dh-frontend-smoke',
      version: '1.0.0',
      private: true,
      scripts: {
        build:
          "node -e \"require('fs').mkdirSync('dist',{recursive:true}); require('fs').writeFileSync('dist/index.html','<!doctype html><title>t</title>ok-frontend')\"",
      },
    });
    await execa('npm', ['install', '--package-lock-only'], { cwd: tmp });
  },
});
