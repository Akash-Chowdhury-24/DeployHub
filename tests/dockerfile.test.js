import {
  generateDockerfile,
  generateDockerignore,
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

  test('generateDockerignore excludes node_modules and dist for React', () => {
    const ignore = generateDockerignore({
      projectType: 'frontend',
      framework: 'react',
      buildOutput: 'dist',
    });
    expect(ignore).toContain('node_modules');
    expect(ignore).toContain('dist');
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

  test('generates Laravel Dockerfile that serves HTTP (not bare php-fpm)', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'laravel',
      port: 80,
    });

    expect(dockerfile).toContain('FROM php:8.2-cli-alpine');
    expect(dockerfile).toContain('EXPOSE 80');
    expect(dockerfile).toContain('artisan');
    expect(dockerfile).toContain('serve');
    expect(dockerfile).not.toContain('php-fpm');
    expect(dockerfile).not.toContain('FROM php:8.2-fpm-alpine');
  });

  test('generates Symfony Dockerfile that binds PHP built-in server to EXPOSE', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'symfony',
      port: 80,
    });

    expect(dockerfile).toContain('FROM php:8.2-cli-alpine');
    expect(dockerfile).toContain('0.0.0.0:80');
    expect(dockerfile).toContain('-t');
    expect(dockerfile).toContain('public');
    expect(dockerfile).not.toContain('CMD ["php-fpm"]');
  });

  test('generates plain PHP Dockerfile with built-in HTTP server (not php-fpm)', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'php',
      port: 8080,
    });

    expect(dockerfile).toContain('FROM php:8.2-cli-alpine');
    expect(dockerfile).toContain('EXPOSE 8080');
    expect(dockerfile).toContain('php -S 0.0.0.0:8080');
    expect(dockerfile).toContain('[ -d public ]');
    expect(dockerfile).toContain('composer install');
    expect(dockerfile).not.toContain('php-fpm');
    expect(dockerfile).not.toContain('FROM node:');
  });

  test('Go Dockerfile tolerates missing go.sum and runs compiled binary', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'go',
      port: 8080,
    });
    expect(dockerfile).toContain('COPY go.mod go.sum*');
    expect(dockerfile).toContain('CMD ["./app"]');
  });

  test('.NET Dockerfile publishes under /src so runtime COPY matches', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'dotnet',
      port: 5000,
    });
    expect(dockerfile).toContain('dotnet publish -c Release -o publish');
    expect(dockerfile).toContain('COPY --from=build /src/publish');
    expect(dockerfile).toContain('ASPNETCORE_URLS=http://+:5000');
    expect(dockerfile).not.toContain('-o /app/publish');
  });

  test('Rails Dockerfile binds Puma to 0.0.0.0 (not puma.rb-only)', () => {
    const dockerfile = generateDockerfile({
      projectType: 'backend',
      framework: 'rails',
      port: 3000,
    });
    expect(dockerfile).toContain('0.0.0.0:3000');
    expect(dockerfile).toContain('puma');
    expect(dockerfile).not.toContain('puma.rb');
  });

  test('plain python/node frameworks do not fall through to wrong images', () => {
    const py = generateDockerfile({
      projectType: 'backend',
      framework: 'python',
      port: 8000,
    });
    expect(py).toContain('FROM python:3.11-slim');
    expect(py).toContain('http.server');
    expect(py).not.toContain('FROM node:');

    const node = generateDockerfile({
      projectType: 'backend',
      framework: 'node',
      port: 3000,
      startCommand: 'npm start',
    });
    expect(node).toContain('FROM node:20-alpine');
    expect(node).toContain('CMD ["npm","start"]');
  });

  test('frontend static Dockerfile uses nginx daemon off', () => {
    const dockerfile = generateDockerfile({
      projectType: 'frontend',
      framework: 'react',
      buildCommand: 'npm run build',
      buildOutput: 'dist',
    });
    expect(dockerfile).toContain('nginx:alpine');
    expect(dockerfile).toContain('daemon off');
  });
});
