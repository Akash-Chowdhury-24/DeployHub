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
  return {
    framework: 'python',
    buildCommand: 'pip install -r requirements.txt',
    buildOutput: 'dist',
    hasDocker,
  };
}

export default { detect, getInfo };
