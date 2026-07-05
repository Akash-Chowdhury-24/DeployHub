import {
  generateDockerfile,
  getDockerfileFrameworkLabel,
  resolveDockerSettings,
} from '../src/utils/dockerfile.js';

describe('dockerfile generation', () => {
  test('generates multi-stage Dockerfile for Express backend', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'express',
      startCommand: 'npm start',
      port: 3000,
    });

    expect(dockerfile).toContain('FROM node:20-alpine');
    expect(dockerfile).toContain('EXPOSE 3000');
    expect(dockerfile).toContain('CMD');
  });

  test('generates nginx-served static frontend for React', () => {
    const dockerfile = generateDockerfile({
      projectType: 'frontend',
      framework: 'react',
      buildCommand: 'npm run build',
      buildOutput: 'dist',
    });

    expect(dockerfile).toContain('FROM nginx:alpine');
    expect(dockerfile).toContain('/app/dist');
    expect(dockerfile).toContain('EXPOSE 80');
  });

  test('generates Python FastAPI Dockerfile', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'fastapi',
      startCommand: 'uvicorn main:app --host 0.0.0.0 --port 8000',
      port: 8000,
    });

    expect(dockerfile).toContain('FROM python:3.11-slim');
    expect(dockerfile).toContain('EXPOSE 8000');
  });

  test('resolveDockerSettings prefers backend config in monorepo', () => {
    const settings = resolveDockerSettings({
      projectType: 'both',
      backend: {
        framework: 'nestjs',
        port: 4000,
        startCommand: 'node dist/main',
      },
    });

    expect(settings.framework).toBe('nestjs');
    expect(settings.port).toBe(4000);
  });

  test('getDockerfileFrameworkLabel returns readable names', () => {
    expect(getDockerfileFrameworkLabel('nestjs')).toBe('NestJS');
    expect(getDockerfileFrameworkLabel('fastapi')).toBe('FastAPI');
  });
});
