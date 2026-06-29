import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const pkg = fs.readJsonSync(pkgPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return !!(deps['@angular/core']);
}

function getInfo(cwd = process.cwd()) {
  const pkg = fs.readJsonSync(path.join(cwd, 'package.json'));
  const scripts = pkg.scripts || {};
  return {
    framework: 'angular',
    buildCommand: scripts.build ? 'npm run build' : 'ng build',
    buildOutput: 'dist',
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
