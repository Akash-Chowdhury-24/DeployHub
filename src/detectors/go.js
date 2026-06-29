import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  return (
    fs.existsSync(path.join(cwd, 'go.mod')) ||
    fs.existsSync(path.join(cwd, 'main.go'))
  );
}

function getInfo(cwd = process.cwd()) {
  return {
    framework: 'go',
    buildCommand: 'go build -o bin/app .',
    buildOutput: 'bin',
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
