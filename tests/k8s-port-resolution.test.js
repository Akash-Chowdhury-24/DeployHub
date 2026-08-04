import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  parseDockerfileExposePort,
  resolveFallbackContainerPort,
  resolveContainerPort,
} from '../src/utils/dockerfile-expose.js';
import {
  generateKubernetesManifests,
  patchKubernetesManifestPorts,
  resolveKubernetesManifestOptionsFromCwd,
  syncKubernetesManifestPorts,
} from '../src/utils/kubernetes-manifests.js';
import { ensureDockerfile, ensureKubernetesManifests } from '../src/utils/scaffold.js';

describe('parseDockerfileExposePort', () => {
  test('reads last EXPOSE in multi-stage frontend nginx Dockerfile as 80', () => {
    const dockerfile = `FROM node:20-alpine AS build
WORKDIR /app
EXPOSE 3000
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
    expect(parseDockerfileExposePort(dockerfile)).toBe(80);
  });

  test('reads custom Node backend EXPOSE port', () => {
    expect(
      parseDockerfileExposePort('FROM node:20-alpine\nEXPOSE 4000\nCMD ["node","index.js"]\n')
    ).toBe(4000);
  });

  test('handles EXPOSE 80/tcp', () => {
    expect(parseDockerfileExposePort('EXPOSE 80/tcp\n')).toBe(80);
  });

  test('returns null when missing or unparseable', () => {
    expect(parseDockerfileExposePort('FROM scratch\n')).toBeNull();
    expect(parseDockerfileExposePort('EXPOSE $PORT\n')).toBeNull();
    expect(parseDockerfileExposePort('')).toBeNull();
  });
});

describe('resolveFallbackContainerPort', () => {
  test('frontend/nginx-style frameworks fall back to 80', () => {
    expect(
      resolveFallbackContainerPort({ projectType: 'frontend', framework: 'react' })
    ).toBe(80);
  });

  test('Node backend falls back to 3000', () => {
    expect(
      resolveFallbackContainerPort({ projectType: 'backend', framework: 'express' })
    ).toBe(3000);
  });

  test('Python falls back to 8000', () => {
    expect(
      resolveFallbackContainerPort({ projectType: 'backend', framework: 'fastapi' })
    ).toBe(8000);
  });

  test('Java/Go fall back to 8080', () => {
    expect(
      resolveFallbackContainerPort({ projectType: 'backend', framework: 'spring' })
    ).toBe(8080);
    expect(
      resolveFallbackContainerPort({ projectType: 'backend', framework: 'go' })
    ).toBe(8080);
  });

  test('.NET falls back to 5000', () => {
    expect(
      resolveFallbackContainerPort({ projectType: 'backend', framework: 'dotnet' })
    ).toBe(5000);
  });
});

describe('resolveContainerPort precedence', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-expose-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('EXPOSE wins over config.port', async () => {
    await fs.writeFile(path.join(tmp, 'Dockerfile'), 'FROM nginx:alpine\nEXPOSE 80\n');
    const result = await resolveContainerPort(tmp, {
      projectType: 'frontend',
      framework: 'react',
      port: 3000,
    });
    expect(result).toEqual({ port: 80, source: 'expose' });
  });

  test('config.port used when Dockerfile has no EXPOSE', async () => {
    await fs.writeFile(path.join(tmp, 'Dockerfile'), 'FROM node:20-alpine\n');
    const result = await resolveContainerPort(tmp, {
      projectType: 'backend',
      framework: 'express',
      port: 4000,
    });
    expect(result).toEqual({ port: 4000, source: 'config' });
  });

  test('per-type fallback when missing Dockerfile', async () => {
    const frontend = await resolveContainerPort(tmp, {
      projectType: 'frontend',
      framework: 'vue',
    });
    expect(frontend).toEqual({ port: 80, source: 'fallback' });

    const backend = await resolveContainerPort(tmp, {
      projectType: 'backend',
      framework: 'express',
    });
    expect(backend).toEqual({ port: 3000, source: 'fallback' });
  });
});

describe('manifest generation uses resolved container port', () => {
  /** @type {string} */
  let tmp;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-k8s-port-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('frontend/nginx Dockerfile → manifests use containerPort/targetPort 80, Service port stays 80', async () => {
    await fs.writeFile(
      path.join(tmp, 'Dockerfile'),
      'FROM nginx:alpine\nEXPOSE 80\nCMD ["nginx","-g","daemon off;"]\n'
    );

    const options = await resolveKubernetesManifestOptionsFromCwd(
      tmp,
      { project: 'web', projectType: 'frontend', framework: 'react' },
      { production: { type: 'kubernetes', kubeNamespace: 'demo' } }
    );
    expect(options.port).toBe(80);
    expect(options.portSource).toBe('expose');

    const { deploymentYaml, serviceYaml } = generateKubernetesManifests(options);
    expect(deploymentYaml).toContain('containerPort: 80');
    expect(serviceYaml).toContain('port: 80');
    expect(serviceYaml).toContain('targetPort: 80');
  });

  test('Node backend custom EXPOSE → that exact port; Service port remains 80', async () => {
    await fs.writeFile(
      path.join(tmp, 'Dockerfile'),
      'FROM node:20-alpine\nEXPOSE 4000\nCMD ["node","server.js"]\n'
    );

    const options = await resolveKubernetesManifestOptionsFromCwd(
      tmp,
      { project: 'api', projectType: 'backend', framework: 'express', port: 3000 },
      { production: { type: 'kubernetes' } }
    );
    expect(options.port).toBe(4000);

    const { deploymentYaml, serviceYaml } = generateKubernetesManifests(options);
    expect(deploymentYaml).toContain('containerPort: 4000');
    expect(serviceYaml).toContain('targetPort: 4000');
    expect(serviceYaml).toMatch(/port:\s*80/);
  });

  test('ensureKubernetesManifests after ensureDockerfile uses EXPOSE 80 for frontend', async () => {
    const config = {
      project: 'spa',
      projectType: 'frontend',
      framework: 'react',
      buildCommand: 'npm run build',
      buildOutput: 'dist',
      environments: {
        production: { type: 'kubernetes', kubeNamespace: 'spa' },
      },
    };

    await ensureDockerfile(tmp, config, { silent: true });
    const dockerfile = await fs.readFile(path.join(tmp, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('EXPOSE 80');

    const result = await ensureKubernetesManifests(
      tmp,
      config,
      config.environments,
      { silent: true }
    );
    expect(result.generated).toBe(true);

    const deployment = await fs.readFile(path.join(tmp, 'k8s', 'deployment.yaml'), 'utf8');
    const service = await fs.readFile(path.join(tmp, 'k8s', 'service.yaml'), 'utf8');
    expect(deployment).toContain('containerPort: 80');
    expect(service).toContain('targetPort: 80');
  });
});

describe('patchKubernetesManifestPorts / sync-k8s-ports', () => {
  test('patch only changes containerPort and targetPort', () => {
    const original = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: app
        image: app:1
        ports:
        - containerPort: 3000
        env:
        - name: FOO
          value: bar
        resources:
          limits:
            memory: "1Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  ports:
  - port: 80
    targetPort: 3000
`;

    const { content, changed } = patchKubernetesManifestPorts(original, 80);
    expect(changed).toBe(true);
    expect(content).toContain('containerPort: 80');
    expect(content).toContain('targetPort: 80');
    expect(content).toContain('replicas: 3');
    expect(content).toContain('memory: "1Gi"');
    expect(content).toContain('value: bar');
    expect(content).toMatch(/port:\s*80/);
    // Service port line preserved (still 80); only targetPort moved from 3000
    expect(content).not.toContain('containerPort: 3000');
    expect(content).not.toContain('targetPort: 3000');
  });

  test('syncKubernetesManifestPorts updates existing files surgically', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deployhub-sync-ports-'));
    try {
      await fs.ensureDir(path.join(tmp, 'k8s'));
      const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: demo
        ports:
        - containerPort: 3000
        resources:
          limits:
            cpu: "250m"
`;
      const service = `apiVersion: v1
kind: Service
metadata:
  name: demo
spec:
  ports:
  - port: 80
    targetPort: 3000
`;
      await fs.writeFile(path.join(tmp, 'k8s', 'deployment.yaml'), deployment);
      await fs.writeFile(path.join(tmp, 'k8s', 'service.yaml'), service);
      await fs.writeFile(path.join(tmp, 'Dockerfile'), 'FROM nginx:alpine\nEXPOSE 80\n');

      const result = await syncKubernetesManifestPorts(tmp, 80);
      expect(result.patched).toEqual(
        expect.arrayContaining([
          expect.stringContaining('deployment.yaml'),
          expect.stringContaining('service.yaml'),
        ])
      );

      const depOut = await fs.readFile(path.join(tmp, 'k8s', 'deployment.yaml'), 'utf8');
      const svcOut = await fs.readFile(path.join(tmp, 'k8s', 'service.yaml'), 'utf8');
      expect(depOut).toContain('containerPort: 80');
      expect(depOut).toContain('replicas: 2');
      expect(depOut).toContain('cpu: "250m"');
      expect(svcOut).toContain('targetPort: 80');
      expect(svcOut).toMatch(/^\s*- port: 80$/m);
    } finally {
      await fs.remove(tmp);
    }
  });
});
