import { smokeDockerfile, fs, path } from './lib/smoke-docker.mjs';

await smokeDockerfile({
  framework: 'fastapi',
  port: 8000,
  hostPort: 18800,
  expectBody: 'ok-fastapi',
  setup: async (tmp) => {
    await fs.writeFile(
      path.join(tmp, 'requirements.txt'),
      'fastapi==0.115.0\nuvicorn[standard]==0.30.6\n'
    );
    await fs.writeFile(
      path.join(tmp, 'main.py'),
      `from fastapi import FastAPI
app = FastAPI()
@app.get("/")
def root():
    return "ok-fastapi"
`
    );
  },
});
