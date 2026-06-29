import fs from 'fs-extra';
import path from 'path';

function detect(cwd = process.cwd()) {
  return (
    fs.existsSync(path.join(cwd, 'pom.xml')) ||
    fs.existsSync(path.join(cwd, 'build.gradle')) ||
    fs.existsSync(path.join(cwd, 'build.gradle.kts'))
  );
}

function getInfo(cwd = process.cwd()) {
  const isGradle =
    fs.existsSync(path.join(cwd, 'build.gradle')) ||
    fs.existsSync(path.join(cwd, 'build.gradle.kts'));
  return {
    framework: 'java',
    buildCommand: isGradle ? './gradlew build' : 'mvn package',
    buildOutput: 'target',
    hasDocker: fs.existsSync(path.join(cwd, 'Dockerfile')),
  };
}

export default { detect, getInfo };
