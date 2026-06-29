import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  const files = fs.readdirSync(cwd);
  return files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
}

function getInfo(cwd = process.cwd()) {
  return {
    framework: 'dotnet',
    buildCommand: 'dotnet build -c Release',
    buildOutput: 'bin/Release',
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
