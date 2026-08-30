import { jest } from '@jest/globals';
import { resolveDockerRemoteMode } from '../src/utils/docker-remote-mode.js';
import {
  classifyRemoteDockerPs,
  buildRemoteDockerCommands,
  formatRemoteDockerSshFailure,
  formatRemoteDockerNotInstalled,
  formatRemoteDockerPermissionDenied,
  formatRemoteDockerDaemonOk,
} from '../src/utils/docker-remote.js';
import {
  getDeploymentEnvKeys,
  getDeploymentSecretKeys,
  getDeploymentWorkflowSecretKeys,
  generateDeploymentEnvSection,
  getMethodEnvDefs,
  applyEnvSecretOverlay,
} from '../src/deployment/deployment-env.js';
import { generateEnvExampleContent, generateWorkflowYaml } from '../src/utils/github-actions.js';
import { buildServerEnvEntry } from '../src/deployment/init-prompts.js';
import {
  mergeMethodSettingsIntoEnv,
  getEnvSettings,
  METHOD_SETTINGS_ENV_OVERLAY,
} from '../src/core/environments.js';
import { saveConfig, loadConfig } from '../src/core/config.js';
import { getBackendInfo } from '../src/detectors/backend.detector.js';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { shellQuote } from '../src/utils/shell-quote.js';
import {
  formatDockerPortNotPublished,
  formatDockerSshPortRequired,
  evaluateDockerPortPublish,
  inspectShowsHostPortMapping,
  resolveDockerPublishPort,
  checkEnvDockerPortPublish,
} from '../src/utils/docker-port-publish.js';

describe('resolveDockerRemoteMode', () => {
  test('explicit remote.mode wins', () => {
    expect(resolveDockerRemoteMode({ remote: { mode: 'ssh' } }, {})).toBe('ssh');
    expect(resolveDockerRemoteMode({ remote: { mode: 'local' } }, { DOCKER_HOST: 'tcp://x' })).toBe(
      'local'
    );
    expect(resolveDockerRemoteMode({ remote: { mode: 'raw' } }, {})).toBe('raw');
  });

  test('existing DOCKER_HOST without remote.mode is raw (no breaking migration)', () => {
    expect(resolveDockerRemoteMode({}, { DOCKER_HOST: 'ssh://ubuntu@203.0.113.10' })).toBe('raw');
    expect(resolveDockerRemoteMode({ dockerHost: 'tcp://203.0.113.10:2376' }, {})).toBe('raw');
  });

  test('no remote.mode and no DOCKER_HOST is local', () => {
    expect(resolveDockerRemoteMode({}, {})).toBe('local');
  });

  test('remote.mode ssh without SSH_HOST stays ssh (does not silently fall back to local)', () => {
    expect(resolveDockerRemoteMode({ remote: { mode: 'ssh' } }, {})).toBe('ssh');
    expect(
      resolveDockerRemoteMode({ remote: { mode: 'ssh' } }, { DOCKER_HOST: 'tcp://203.0.113.10:2376' })
    ).toBe('ssh');
  });

  test('blank or unknown remote.mode is not treated as explicit', () => {
    expect(resolveDockerRemoteMode({ remote: { mode: '' } }, {})).toBe('local');
    expect(resolveDockerRemoteMode({ remote: { mode: 'SSH' } }, {})).toBe('local');
    expect(
      resolveDockerRemoteMode({ remote: { mode: 'nope' } }, { DOCKER_HOST: 'tcp://x' })
    ).toBe('raw');
  });
});

describe('remote docker command quoting', () => {
  test('buildRemoteDockerCommands shell-quotes image, name, and -e values', () => {
    const cmds = buildRemoteDockerCommands("myorg/app:tag'x", 'web;rm', {
      FOO: "bar'baz",
    });
    expect(cmds.pull).toBe(`docker pull ${shellQuote("myorg/app:tag'x")}`);
    expect(cmds.run).toContain(`--name ${shellQuote('web;rm')}`);
    expect(cmds.run).toContain(`-e ${shellQuote("FOO=bar'baz")}`);
    expect(cmds.run).not.toContain(' -p ');
    expect(cmds.stop).toContain(shellQuote('web;rm'));
    expect(cmds.rm).toContain(shellQuote('web;rm'));
  });

  test('buildRemoteDockerCommands quotes -p host:container when publishPort is set', () => {
    const cmds = buildRemoteDockerCommands('nginx:alpine', 'web', {}, { publishPort: 80 });
    expect(cmds.run).toContain(`-p ${shellQuote('80:80')}`);
  });
});

describe('docker port publish inspect', () => {
  test('exact unpublished message', () => {
    expect(formatDockerPortNotPublished('hello-world', 80)).toBe(
      "Container 'hello-world' is running but port 80 is not published on the host (no 0.0.0.0:80-> mapping).\nThe app is not reachable from outside the container."
    );
  });

  test('ssh missing port is loud, not a silent unpublished run', () => {
    expect(formatDockerSshPortRequired('production')).toMatch(/requires a published port/);
    expect(resolveDockerPublishPort({}, {})).toBeNull();
    expect(resolveDockerPublishPort({}, { port: 80 })).toBe(80);
    expect(resolveDockerPublishPort({ port: 8000 }, {})).toBe(8000);
  });

  test('inspectShowsHostPortMapping requires 0.0.0.0:<port>->', () => {
    expect(inspectShowsHostPortMapping('0.0.0.0:80->80/tcp', 80)).toBe(true);
    expect(inspectShowsHostPortMapping('', 80)).toBe(false);
    expect(inspectShowsHostPortMapping('0.0.0.0:8080->8080/tcp', 80)).toBe(false);
  });

  test('evaluate: running unpublished fails with exact copy', () => {
    const verdict = evaluateDockerPortPublish(
      { code: 0, stdout: 'running|' },
      { containerName: 'hello-world', port: 80, requireRunning: true }
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.message).toBe(formatDockerPortNotPublished('hello-world', 80));
  });

  test('evaluate: stopped container is skip when requireRunning is false', () => {
    const verdict = evaluateDockerPortPublish(
      { code: 0, stdout: 'stopped|' },
      { containerName: 'hello-world', port: 80, requireRunning: false }
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe('not-running');
  });

  test('evaluate: missing container is skip when requireRunning is false', () => {
    const verdict = evaluateDockerPortPublish(
      { code: 1, stdout: '', stderr: 'No such object' },
      { containerName: 'hello-world', port: 80, requireRunning: false }
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe('not-running');
  });
});

describe('classifyRemoteDockerPs', () => {
  test('ok on exit 0', () => {
    expect(classifyRemoteDockerPs({ code: 0, stdout: 'CONTAINER', stderr: '' })).toBe('ok');
  });

  test('permission denied on docker socket', () => {
    expect(
      classifyRemoteDockerPs({
        code: 1,
        stdout: '',
        stderr:
          'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
      })
    ).toBe('permission');
  });

  test('docker not installed', () => {
    expect(
      classifyRemoteDockerPs({ code: 127, stdout: '', stderr: 'bash: docker: command not found' })
    ).toBe('not-installed');
  });
});

describe('doctor message copy (exact)', () => {
  test('SSH-level failure is not a Docker-level message', () => {
    expect(formatRemoteDockerSshFailure('203.0.113.10', 'ubuntu')).toBe(
      "Could not reach 203.0.113.10 via SSH as 'ubuntu'. Check host,\nusername, and key path."
    );
  });

  test('docker not installed', () => {
    expect(formatRemoteDockerNotInstalled('203.0.113.10', 'ubuntu')).toBe(
      'Docker is not installed on the remote host (ubuntu@203.0.113.10).\nInstall Docker on the server first: https://docs.docker.com/engine/install/'
    );
  });

  test('permission denied', () => {
    expect(formatRemoteDockerPermissionDenied('203.0.113.10', 'ubuntu')).toBe(
      "SSH user 'ubuntu' cannot access the Docker daemon on 203.0.113.10\n(permission denied).\nRun this on the remote server, then reconnect your SSH session:\nsudo usermod -aG docker ubuntu"
    );
  });

  test('daemon reachable success', () => {
    expect(formatRemoteDockerDaemonOk('203.0.113.10', 'ubuntu')).toBe(
      'Remote Docker daemon reachable (ubuntu@203.0.113.10)'
    );
  });
});

describe('docker env defs by remote.mode', () => {
  test('legacy docker (no remote.mode) still lists optional DOCKER_HOST', () => {
    const keys = getDeploymentWorkflowSecretKeys('docker');
    expect(keys).toContain('DOCKER_HOST');
    expect(keys).not.toContain('SSH_HOST');
    expect(getDeploymentEnvKeys('docker')).toEqual(['DOCKER_IMAGE_NAME']);
    expect(getDeploymentSecretKeys('docker')).toEqual(['DOCKER_IMAGE_NAME']);
  });

  test('explicit local omits DOCKER_HOST', () => {
    const settings = { remote: { mode: 'local' } };
    const keys = getMethodEnvDefs('docker', settings).map((d) => d.key);
    expect(keys).not.toContain('DOCKER_HOST');
    expect(keys).not.toContain('SSH_HOST');
  });

  test('ssh mode adds SSH_* and drops raw DOCKER_HOST', () => {
    const settings = { remote: { mode: 'ssh' }, host: '203.0.113.10', user: 'ubuntu' };
    expect(getDeploymentEnvKeys('docker', null, settings)).toEqual(
      expect.arrayContaining(['DOCKER_IMAGE_NAME', 'SSH_HOST', 'SSH_USER', 'SSH_KEY_PATH'])
    );
    expect(getDeploymentEnvKeys('docker', null, settings)).not.toContain('DOCKER_HOST');
    expect(getDeploymentSecretKeys('docker', null, settings)).toEqual(
      expect.arrayContaining(['DOCKER_IMAGE_NAME', 'SSH_HOST', 'SSH_USER', 'SSH_KEY'])
    );
    expect(getDeploymentWorkflowSecretKeys('docker', null, settings)).toContain('SSH_KEY');
    expect(getDeploymentWorkflowSecretKeys('docker', null, settings)).not.toContain('DOCKER_HOST');
  });

  test('raw mode keeps DOCKER_HOST', () => {
    const settings = { remote: { mode: 'raw' }, dockerHost: 'tcp://203.0.113.10:2376' };
    expect(getMethodEnvDefs('docker', settings).map((d) => d.key)).toContain('DOCKER_HOST');
  });

  test('.env.example for docker-ssh includes SSH vars and host default', () => {
    const content = generateDeploymentEnvSection(
      'docker',
      { projectType: 'frontend', project: 'myapp' },
      {
        production: {
          method: 'docker',
          config: {
            remote: { mode: 'ssh' },
            host: '203.0.113.10',
            user: 'ubuntu',
            dockerImageName: 'myorg/myapp',
          },
        },
      },
      { envName: 'production' }
    );
    expect(content).toContain('SSH_HOST=203.0.113.10');
    expect(content).toContain('SSH_USER=ubuntu');
    expect(content).toContain('SSH_KEY_PATH=');
    expect(content).not.toMatch(/^DOCKER_HOST=/m);
  });

  test('generateEnvExampleContent wires docker-ssh SSH keys', () => {
    const content = generateEnvExampleContent(
      [],
      ['production'],
      {
        production: {
          method: 'docker',
          config: { remote: { mode: 'ssh' }, host: '203.0.113.10', user: 'ubuntu' },
        },
      },
      { projectType: 'frontend', project: 'myapp' }
    );
    expect(content).toContain('SSH_HOST=203.0.113.10');
    expect(content).toContain('SSH_KEY_PATH=');
  });

  test('workflow yaml for docker-ssh includes SSH secrets, not DOCKER_HOST', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['development'],
      {
        development: {
          method: 'docker',
          config: { remote: { mode: 'ssh' }, host: '203.0.113.10', user: 'ubuntu' },
        },
      },
      'npm:@akash-chowdhury-24/deployhub',
      { projectType: 'frontend', framework: 'react' }
    );
    expect(yaml).toContain('SSH_HOST: ${{ secrets.SSH_HOST }}');
    expect(yaml).toContain('SSH_USER: ${{ secrets.SSH_USER }}');
    expect(yaml).toContain('SSH_KEY: ${{ secrets.SSH_KEY }}');
    expect(yaml).not.toContain('DOCKER_HOST: ${{ secrets.DOCKER_HOST }}');
  });

  test('legacy docker workflow still wires DOCKER_HOST', () => {
    const yaml = generateWorkflowYaml(
      ['local'],
      ['development'],
      { development: { type: 'docker' } },
      'npm:@akash-chowdhury-24/deployhub',
      { projectType: 'frontend', framework: 'react' }
    );
    expect(yaml).toContain('DOCKER_HOST: ${{ secrets.DOCKER_HOST }}');
    expect(yaml).not.toContain('SSH_HOST: ${{ secrets.SSH_HOST }}');
  });
});

describe('buildServerEnvEntry docker remote', () => {
  test('ssh mode writes remote.mode and host/user, never keyPath', () => {
    const entry = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'ssh',
        dockerImageName: 'org/app',
        host: '203.0.113.10',
        user: 'ubuntu',
        keyPath: '~/.ssh/id_rsa',
      },
      'frontend',
      'demo',
      null,
      null
    );
    expect(entry.config.remote).toEqual({ mode: 'ssh' });
    expect(entry.config.host).toBe('203.0.113.10');
    expect(entry.config.user).toBe('ubuntu');
    expect(entry.config.keyPath).toBeUndefined();
    expect(entry.config.dockerHost).toBe('');
  });

  test('local mode writes remote.mode local', () => {
    const entry = buildServerEnvEntry(
      { deployType: 'docker', remoteMode: 'local', dockerImageName: 'org/app' },
      'frontend',
      'demo',
      null,
      null
    );
    expect(entry.config.remote).toEqual({ mode: 'local' });
  });

  test('raw mode keeps dockerHost', () => {
    const entry = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'raw',
        dockerImageName: 'org/app',
        dockerHost: 'tcp://203.0.113.10:2376',
      },
      'frontend',
      'demo',
      null,
      null
    );
    expect(entry.config.remote).toEqual({ mode: 'raw' });
    expect(entry.config.dockerHost).toBe('tcp://203.0.113.10:2376');
  });

  test('docker branch copies deployAnswers.port onto environments.<env>.config.port', () => {
    const entry = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'ssh',
        dockerImageName: 'org/app',
        host: '203.0.113.10',
        user: 'ubuntu',
        port: 9000,
      },
      'backend',
      'demo',
      null,
      { port: 8000 }
    );
    expect(entry.config.port).toBe(9000);
  });

  test('docker branch copies singleConfig.port when env add/init did not pass deployAnswers.port', () => {
    const entry = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'ssh',
        dockerImageName: 'org/app',
        host: '203.0.113.10',
        user: 'ubuntu',
      },
      'backend',
      'demo',
      null,
      { port: 8000 }
    );
    expect(entry.config.port).toBe(8000);
  });

  test('two docker envs from env add keep independent ports', () => {
    const production = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'ssh',
        dockerImageName: 'org/app',
        host: '203.0.113.10',
        user: 'ubuntu',
        port: 8000,
      },
      'backend',
      'demo',
      null,
      null
    );
    const staging = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'ssh',
        dockerImageName: 'org/app',
        host: '203.0.113.11',
        user: 'ubuntu',
        port: 9000,
      },
      'backend',
      'demo',
      null,
      { port: 8000 }
    );
    const config = {
      project: 'demo',
      port: 8000,
      defaultEnvironment: 'production',
      environments: { production, staging },
    };

    expect(production.config.port).toBe(8000);
    expect(staging.config.port).toBe(9000);
    expect(
      resolveDockerPublishPort(config, getEnvSettings(production), 'production')
    ).toBe(8000);
    expect(resolveDockerPublishPort(config, getEnvSettings(staging), 'staging')).toBe(9000);
  });

  test('legacy demo-fastapi-project top-level port still resolves via fallback', async () => {
    const defaults = getBackendInfo('fastapi');
    const environments = {
      default: {
        enabled: true,
        method: 'docker',
        trigger: 'push',
        config: {
          deploymentType: 'server',
          dockerImageName: 'demo-fastapi-project',
          dockerRegistryUrl: '',
          remote: { mode: 'ssh' },
          dockerHost: '',
          host: '203.0.113.10',
          user: 'ubuntu',
        },
      },
    };

    const config = {
      project: 'demo-fastapi-project',
      version: '0.0.0',
      projectType: 'backend',
      framework: 'fastapi',
      language: defaults.language,
      buildCommand: defaults.buildCommand ?? null,
      startCommand: defaults.startCommand,
      buildOutput: defaults.buildOutput,
      port: 8000,
      artifact: true,
      storage: ['local'],
      defaultEnvironment: 'default',
      unprefixedSecretEnvironment: 'default',
      legacyHistoryMigrated: true,
      environments,
      healthCheck: { url: '', timeout: 30 },
      pipeline: { test: true, docker: true, deploy: true, verify: false, notify: false },
    };

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-fastapi-init-port-'));
    try {
      await saveConfig(config, tmp);
      const onDisk = await fs.readJson(path.join(tmp, 'deployhub.config.json'));
      const loaded = await loadConfig(tmp);

      expect(onDisk.port).toBe(8000);
      expect(onDisk.environments.default.config.port).toBeUndefined();
      expect(loaded.port).toBe(8000);
      expect(loaded.environments.default.config.port).toBeUndefined();
      expect(
        resolveDockerPublishPort(
          loaded,
          getEnvSettings(loaded.environments.default),
          'default'
        )
      ).toBe(8000);
    } finally {
      await fs.remove(tmp);
    }
  });

  test('env add docker ssh with no port fails loudly instead of inheriting top-level', async () => {
    const production = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'ssh',
        dockerImageName: 'demo-fastapi-project',
        host: '203.0.113.10',
        user: 'ubuntu',
        port: 8000,
      },
      'backend',
      'demo-fastapi-project',
      null,
      { port: 8000 }
    );
    // Same as `deployhub env add staging --method docker --yes`: no port answer,
    // and env add does not pass top-level singleConfig.port through.
    const staging = buildServerEnvEntry(
      {
        deployType: 'docker',
        remoteMode: 'ssh',
        dockerImageName: 'demo-fastapi-project',
        host: '203.0.113.11',
        user: 'ubuntu',
      },
      'backend',
      'demo-fastapi-project',
      null,
      { framework: 'fastapi', port: undefined }
    );

    const config = {
      project: 'demo-fastapi-project',
      port: 8000,
      defaultEnvironment: 'production',
      environments: { production, staging },
    };

    expect(production.config.port).toBe(8000);
    expect(staging.config.port).toBeUndefined();
    expect(
      resolveDockerPublishPort(config, getEnvSettings(production), 'production')
    ).toBe(8000);
    expect(resolveDockerPublishPort(config, getEnvSettings(staging), 'staging')).toBeNull();

    const outcome = await checkEnvDockerPortPublish(config, 'staging', {
      requireRunning: false,
    });
    expect(outcome.pass).toBe(false);
    expect(outcome.message).toBe(formatDockerSshPortRequired('staging'));
  });
});

describe('kubernetes overlay ignores remote.mode', () => {
  test('allowlist structurally excludes docker-ssh identity fields', () => {
    const settingKeys = Object.keys(METHOD_SETTINGS_ENV_OVERLAY);
    const envKeys = Object.values(METHOD_SETTINGS_ENV_OVERLAY);
    expect(settingKeys).not.toContain('remote');
    expect(settingKeys).not.toContain('host');
    expect(settingKeys).not.toContain('user');
    expect(settingKeys).not.toContain('keyPath');
    expect(envKeys).not.toContain('SSH_HOST');
    expect(envKeys).not.toContain('SSH_USER');
    expect(envKeys).not.toContain('SSH_KEY_PATH');
    expect(envKeys).not.toContain('SSH_KEY');
  });

  test('kubernetes env with remote.mode ssh does not resolve docker-ssh vars', () => {
    const config = {
      project: 'myapp',
      projectType: 'frontend',
      unprefixedSecretEnvironment: 'development',
      environments: {
        development: {
          enabled: true,
          method: 'ssh',
          trigger: 'push',
          config: { host: 'dev.example.com', user: 'deploy' },
        },
        production: {
          enabled: true,
          method: 'kubernetes',
          trigger: 'manual',
          config: {
            remote: { mode: 'ssh' },
            host: '203.0.113.10',
            user: 'ubuntu',
            keyPath: '~/.ssh/id_rsa',
            kubeNamespace: 'prod',
            kubeconfig: '/tmp/kube',
            kubeContext: 'prod-ctx',
            dockerImageName: 'org/app',
            dockerRegistryUrl: 'ghcr.io/org',
          },
        },
      },
    };

    const settings = getEnvSettings(config.environments.production);
    const overlay = mergeMethodSettingsIntoEnv(
      {
        SSH_HOST: 'leftover-from-shell.example',
        SSH_USER: 'leftover-user',
        KUBECONFIG: '/tmp/kube',
      },
      settings
    );

    expect(overlay.DOCKER_IMAGE_NAME).toBe('org/app');
    expect(overlay.DOCKER_REGISTRY_URL).toBe('ghcr.io/org');
    expect(overlay.KUBE_NAMESPACE).toBe('prod');
    expect(overlay.KUBE_CONTEXT).toBe('prod-ctx');
    expect(overlay.SSH_HOST).toBe('leftover-from-shell.example');
    expect(overlay.SSH_USER).toBe('leftover-user');
    expect(Object.keys(overlay)).not.toContain('remote');
    expect(JSON.stringify(overlay)).not.toMatch(/remote\.mode|"ssh"/);

    const wfKeys = getDeploymentWorkflowSecretKeys('kubernetes', config, settings);
    expect(wfKeys).not.toContain('SSH_HOST');
    expect(wfKeys).not.toContain('SSH_USER');
    expect(wfKeys).not.toContain('SSH_KEY');
    expect(wfKeys).not.toContain('SSH_KEY_PATH');
    expect(getMethodEnvDefs('kubernetes', settings).map((d) => d.key)).toEqual(
      getMethodEnvDefs('kubernetes', {}).map((d) => d.key)
    );

    const remapped = applyEnvSecretOverlay('production', config, {
      PRODUCTION_KUBE_NAMESPACE: 'from-secret',
      SSH_HOST: 'leftover-from-shell.example',
      PRODUCTION_SSH_HOST: 'must-not-be-consumed-by-k8s',
    });
    expect(remapped.KUBE_NAMESPACE).toBe('from-secret');
    expect(remapped.SSH_HOST).toBe('leftover-from-shell.example');
    expect(remapped.PRODUCTION_SSH_HOST).toBe('must-not-be-consumed-by-k8s');
  });
});
