/**
 * Dev-only: run deployhub doctor with malformed SSH key + unreachable host.
 * Not shipped in the npm package or binary bundle.
 */
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execa } from 'execa';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(os.tmpdir(), 'deployhub-doctor-split-qa');
await fs.emptyDir(dir);

const badKeyPath = path.join(dir, 'malformed-key.pem');
await fs.writeFile(badKeyPath, 'not-a-valid-pem-key\n', { mode: 0o600 });

await fs.writeJson(
  path.join(dir, 'deployhub.config.json'),
  {
    project: 'doctor-split-qa',
    projectType: 'backend',
    framework: 'express',
    port: 3000,
    storage: ['local'],
    deploy: ['production'],
    environments: {
      production: {
        type: 'ssh',
        deploymentType: 'server',
        host: '1.2.3.4',
        user: 'ubuntu',
        keyPath: badKeyPath,
        deployPath: '/var/www/app',
        appName: 'doctor-split-qa',
      },
    },
    healthCheck: { url: '', timeout: 30 },
    pipeline: { test: false, deploy: true, verify: false },
  },
  { spaces: 2 }
);

await fs.writeFile(
  path.join(dir, '.env'),
  `SSH_HOST=1.2.3.4
SSH_USER=ubuntu
SSH_KEY_PATH=${badKeyPath.replace(/\\/g, '/')}
SSH_APP_NAME=doctor-split-qa
SSH_PORT=3000
`
);

await fs.ensureDir(path.join(dir, '.git'));
await fs.writeFile(
  path.join(dir, '.git', 'config'),
  '[remote "origin"]\n\turl = https://github.com/test/test.git\n'
);

const cli = path.join(repoRoot, 'src/cli/index.js');
const { stdout, stderr } = await execa('node', [cli, 'doctor'], {
  cwd: dir,
  reject: false,
});
process.stdout.write(stdout);
process.stderr.write(stderr);
