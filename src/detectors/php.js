import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  return fs.existsSync(path.join(cwd, 'composer.json'));
}

function getInfo(cwd = process.cwd()) {
  // Composer install belongs in the install stage, not a compile/build step.
  return {
    framework: 'php',
    buildCommand: null,
    buildOutput: '.',
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
