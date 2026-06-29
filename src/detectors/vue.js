import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const pkg = fs.readJsonSync(pkgPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return !!deps.vue;
}

function getInfo(cwd = process.cwd()) {
  const pkg = fs.readJsonSync(path.join(cwd, 'package.json'));
  const scripts = pkg.scripts || {};
  return {
    framework: 'vue',
    buildCommand: scripts.build ? 'npm run build' : 'npm run build',
    buildOutput: fs.existsSync(path.join(cwd, 'dist')) ? 'dist' : 'build',
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
