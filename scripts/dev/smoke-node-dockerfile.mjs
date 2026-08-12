import { smokeDockerfile, fs, path, execa } from './lib/smoke-docker.mjs';

await smokeDockerfile({
  framework: 'express',
  port: 3000,
  hostPort: 18300,
  expectBody: 'ok-express',
  setup: async (tmp) => {
    await fs.writeJson(path.join(tmp, 'package.json'), {
      name: 'dh-express-smoke',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4.21.0' },
    });
    await fs.writeFile(
      path.join(tmp, 'server.js'),
      `import express from 'express';
const app = express();
app.get('/', (_req, res) => res.send('ok-express'));
app.listen(3000, '0.0.0.0');
`
    );
    await execa('npm', ['install', '--package-lock-only'], { cwd: tmp });
  },
});
