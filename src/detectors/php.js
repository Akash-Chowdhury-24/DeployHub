import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  return fs.existsSync(path.join(cwd, 'composer.json'));
}

function getInfo(cwd = process.cwd()) {
  return {
    framework: 'php',
    buildCommand: 'composer install --no-dev --optimize-autoloader',
    buildOutput: 'public',
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
