import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  return fs.existsSync(path.join(cwd, 'package.json'));
}

function getInfo(cwd = process.cwd()) {
  const pkg = fs.readJsonSync(path.join(cwd, 'package.json'));
  const scripts = pkg.scripts || {};
  let buildCommand = 'npm install';
  if (scripts.build) {
    buildCommand = 'npm run build';
  } else if (scripts.start) {
    buildCommand = 'npm install';
  }
  const outputCandidates = ['dist', 'build', 'out', 'public'];
  const buildOutput =
    outputCandidates.find((d) => fs.existsSync(path.join(cwd, d))) || 'dist';
  return {
    framework: 'node',
    buildCommand,
    buildOutput,
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
