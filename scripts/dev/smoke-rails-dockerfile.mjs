import { smokeDockerfile, fs, path } from './lib/smoke-docker.mjs';

// Rails Dockerfile fitness with a minimal Rack+Puma app (same CMD / process model).
await smokeDockerfile({
  framework: 'rails',
  port: 3000,
  hostPort: 13000,
  expectBody: 'ok-rails',
  readinessMs: 4000,
  setup: async (tmp) => {
    await fs.writeFile(
      path.join(tmp, 'Gemfile'),
      `source 'https://rubygems.org'
gem 'puma', '~> 6.4'
gem 'rack', '~> 3.0'
`
    );
    await fs.writeFile(
      path.join(tmp, 'config.ru'),
      `run proc { |_env| [200, { 'content-type' => 'text/plain' }, ['ok-rails']] }
`
    );
  },
});
