import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  return (
    fs.existsSync(path.join(cwd, 'requirements.txt')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(cwd, 'setup.py'))
  );
}

function getInfo(cwd = process.cwd()) {
  const hasDocker = fs.existsSync(path.join(cwd, 'Dockerfile'));
  // Deps install belongs in the install stage (pip), not a compile/build step.
  return {
    framework: 'python',
    buildCommand: null,
    buildOutput: '.',
    hasDocker,
  };
}

export default { detect, getInfo };
