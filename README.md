# DeployHub

Zero-configuration deployment and artifact manager for Node.js projects. When you push to GitHub, DeployHub automatically detects your project type, builds it, creates a versioned artifact, uploads to cloud storage, and optionally deploys to your server.

**Supported deployment targets:** SSH, Docker, EC2, Azure VM, GCP VM, and Kubernetes — self-hosted and cloud VM only.

DeployHub no longer integrates with managed platforms like Vercel or Netlify — those tools already offer superior native git-push deployment. DeployHub instead focuses on artifact-first backups and self-hosted/server deployment, where no equivalent native solution exists.

## Installation

DeployHub can be installed via **npm** (requires Node.js 18+) or as a **standalone binary** (no Node.js required).

### npm (recommended for Node.js projects)

```bash
npm install -g @akash-chowdhury-24/deployhub
```

Or use locally in your project:

```bash
npm install @akash-chowdhury-24/deployhub
npx deployhub init
```

### Standalone binary (Linux / macOS)

Downloads the latest release from [GitHub Releases](https://github.com/Akash-Chowdhury-24/DeployHub/releases) and installs to `/usr/local/bin` (or `~/.local/bin` without sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/Akash-Chowdhury-24/DeployHub/main/install.sh | sh
```

Supported platforms: Linux x64, macOS x64, macOS ARM64. If the binary download fails, the script falls back to `npm install -g`.

### Standalone binary (Windows)

Run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Akash-Chowdhury-24/DeployHub/main/install.ps1 | iex
```

Installs to `%LOCALAPPDATA%\Programs\DeployHub` and adds it to your user PATH. On Windows ARM64, the script installs via npm instead (no native binary yet).

### Manual download

Pick the asset for your platform from the [latest release](https://github.com/Akash-Chowdhury-24/DeployHub/releases/latest):

| Platform | Asset |
|----------|-------|
| Linux x64 | `deployhub-linux-x64` |
| macOS x64 | `deployhub-macos-x64` |
| macOS ARM64 | `deployhub-macos-arm64` |
| Windows x64 | `deployhub-win.exe` |

Make it executable (Linux/macOS) and place it on your PATH:

```bash
chmod +x deployhub-linux-x64
sudo mv deployhub-linux-x64 /usr/local/bin/deployhub
deployhub --version
```

### Verify installation

```bash
deployhub --version
deployhub doctor
```

To update an npm install: `deployhub update` or `npm install -g @akash-chowdhury-24/deployhub@latest`. For binary installs, re-run the install script or download the new release.

## Quick Start

### 1. Initialize

```bash
deployhub init
```

This interactive wizard will:

- Detect your framework (React, Vue, Next.js, Node, Python, etc.)
- Configure build commands and output directory
- Set up storage providers (AWS, Google Drive, Azure, GCP, Dropbox, Local)
- Optionally configure deployment targets (SSH, Docker, EC2, Azure VM, GCP VM, Kubernetes)
- Generate `deployhub.config.json`
- Generate `.github/workflows/deployhub.yml`
- Generate `.env.example`

### 2. Configure credentials

```bash
cp .env.example .env
# Edit .env with your credentials

deployhub storage add aws
deployhub storage add gdrive
```

### 3. Run pre-flight checks

```bash
deployhub doctor
```

### 4. Deploy

```bash
deployhub build
```

Or push to `main` — GitHub Actions runs `deployhub build` automatically.

For a full walkthrough by project type, language, and deployment mode, see [Complete Tutorial](#complete-tutorial) below.

## Complete Tutorial

This section walks through every supported setup: **frontend only**, **backend only**, **full stack**, **storage only** (build + upload artifacts, no deploy), and **storage + deployment** (build, upload, then deploy). Use it as a checklist from zero to a working pipeline.

### What DeployHub does on every run

When you run `deployhub build` (locally or in GitHub Actions), DeployHub runs these stages in order:

| Stage | What happens |
|-------|----------------|
| **detect** | Auto-detect framework, language, build output |
| **install** | Install dependencies (`npm ci`, `pip install`, `mvn`, etc.) |
| **test** | Run tests (skippable via config) |
| **build** | Run your build command(s) |
| **docker** | Build Docker image if `Dockerfile` exists and enabled |
| **artifact** | Create versioned `artifact.zip` + metadata locally |
| **storage** | Upload artifact to all selected providers (parallel) |
| **deploy** | Deploy to targets — **only if you configured deployment during `init`** |
| **verify** | Hit your health-check URL — **only if configured** |
| **notify** | Slack / email / webhook — **only if enabled** |

**Storage only** means you answer **No** to *Configure deployment?* during `init`. You still get builds and cloud backups; nothing is pushed to a server.

**Storage + deployment** means you answer **Yes**, pick targets, and add the matching secrets. Deploy always runs **after** storage upload succeeds.

---

### Prerequisites (all projects)

1. **Git repository** with a remote (GitHub recommended for CI).
2. **DeployHub installed** — see [Installation](#installation) above.
3. **Run from your project root** (where `package.json`, `go.mod`, `pom.xml`, etc. lives).

| Language / stack | You need on the machine / in CI |
|------------------|----------------------------------|
| Node.js (React, Vue, Express, NestJS, …) | Node.js 18+, npm |
| Python (FastAPI, Django, Flask) | Python 3.11+, `requirements.txt` or `pyproject.toml` |
| PHP (Laravel, Symfony) | PHP, Composer, `composer.json` |
| Java (Spring Boot) | JDK 17+, Maven, `pom.xml` |
| Go | Go 1.22+, `go.mod` |
| .NET | .NET 8 SDK, `.csproj` |
| Ruby on Rails | Ruby 3.2+, Bundler, `Gemfile` |

---

### Step 1 — Initialize (every workflow)

```bash
cd your-project
deployhub init
```

The wizard asks the same core questions for every setup:

| Prompt | What to choose |
|--------|----------------|
| **Project name** | Defaults to folder name; used in artifact paths and deploy paths |
| **What are you deploying?** | `Frontend only` · `Backend only` · `Both (monorepo / fullstack)` |
| **Framework** | Auto-detected when possible; confirm or change |
| **Build command / output** | Pre-filled per framework (see [Framework defaults](#framework-defaults-by-language) below) |
| **Storage providers** | Pick one or more: Local, AWS S3, Google Drive, Azure, GCP, Dropbox |
| **Configure deployment?** | **No** = storage only · **Yes** = storage + deploy |
| **CLI source for GitHub Actions** | Default `npm:@akash-chowdhury-24/deployhub` is fine for most users |

**Generated files:**

- `deployhub.config.json` — project settings (no secrets)
- `.github/workflows/deployhub.yml` — CI pipeline
- `.env.example` — list of env vars you may need
- `nginx.conf` — auto-generated if frontend deploys to SSH

---

### Step 2 — Credentials

```bash
cp .env.example .env
# Edit .env locally

deployhub storage add aws      # repeat per provider
deployhub storage add gdrive
```

For **GitHub Actions**, add the same values as repository secrets (Settings → Secrets and variables → Actions). See [GitHub Secrets](#github-secrets).

---

### Step 3 — Verify

```bash
deployhub doctor
```

Fix any ✗ items before your first build.

---

### Step 4 — Build (and deploy if configured)

```bash
deployhub build
```

Or push to `main` / `master` — the generated workflow runs the same command.

**Useful follow-up commands:**

```bash
deployhub artifact list              # see uploaded versions
deployhub artifact restore v1.2.3    # download a past build
deployhub deploy                     # deploy latest artifact without rebuilding
deployhub rollback v1.2.2            # roll back on server
deployhub logs                       # last deployment logs
```

---

## Walkthrough: Storage only

Use this when you want **versioned build artifacts in the cloud** but deploy manually (or add deployment later).

### During `deployhub init`

1. Choose project type (frontend / backend / both).
2. Select framework and confirm build settings.
3. Check at least one **storage** provider (Local is checked by default).
4. Answer **Configure deployment?** → **No**.

### Resulting config

`deployhub.config.json` will have `"deploy": []` and `"pipeline": { "deploy": false }`. Every `deployhub build` still runs detect → install → test → build → artifact → **storage**.

### Example: React app → AWS S3 only

```bash
deployhub init
# What are you deploying?     → Frontend only
# Framework                   → React
# Build command               → npm run build
# Build output                → dist
# Storage                     → ✓ AWS S3
# Configure deployment?       → No
```

```bash
cp .env.example .env
# Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_BUCKET, AWS_REGION

deployhub doctor
deployhub build
```

Artifacts appear under `artifact/{projectName}/{date}/v{version}/` locally **and** in your S3 bucket.

### Same steps for other languages

Storage-only init is **identical** for every language — only the framework/build prompts change. See [Framework defaults](#framework-defaults-by-language).

---

## Walkthrough: Storage + deployment

Use this when you want **build → upload artifact → deploy** in one command.

### During `deployhub init`

1. Complete project type + framework setup.
2. Select storage provider(s).
3. Answer **Configure deployment?** → **Yes**.
4. Follow the deployment prompts (differs by project type — below).

Deployment **requires** at least one storage provider. DeployHub restores from the uploaded artifact on the target.

---

## Walkthrough: Frontend only

### Init choices

| Prompt | Options |
|--------|---------|
| What are you deploying? | **Frontend only** |
| Framework | React, Vue, Angular, Next.js, Svelte, Astro, Vanilla JS, Other |
| Configure deployment? | No (storage only) or Yes |

If **Yes** to deployment:

| Prompt | Options |
|--------|---------|
| Deployment type | **ssh**, docker, ec2, azure-vm, gcp-vm, kubernetes |
| Host, user, deploy path | SSH credentials and remote directory |

#### Self-hosted server (SSH, Docker, EC2, …)

Best when you serve static files from your own VPS or cloud VM. DeployHub uploads the built `dist/` (or your output dir) over SSH and can generate `nginx.conf`.

| Deploy type | You provide |
|-------------|-------------|
| **ssh** | `SSH_HOST`, `SSH_USER`, `SSH_KEY`, deploy path |
| **docker** | Docker host access / image registry per your setup |
| **ec2** | SSH credentials to EC2 instance |
| **azure-vm** / **gcp-vm** | SSH to VM |
| **kubernetes** | Cluster credentials (via env / kubeconfig) |

**Example: Vue → Google Drive + SSH**

```bash
deployhub init
# Frontend only → Vue
# Storage: Local + Google Drive
# Configure deployment? Yes → ssh
# Host, user, deploy path: /var/www/my-app
```

```bash
cp .env.example .env
# GDRIVE_* and SSH_HOST, SSH_USER, SSH_KEY

deployhub doctor
git push origin main
```

**Example: Angular → Azure Blob + SSH**

```bash
deployhub init
# Frontend only → Angular
# Build: ng build, output dist
# Storage: Azure Blob
# Configure deployment? Yes → Self-hosted → ssh
# Host, user, deploy path: /var/www/my-app
```

Add `AZURE_*`, `SSH_HOST`, `SSH_USER`, `SSH_KEY` to `.env` and GitHub Secrets. Review the generated `nginx.conf` and install it on the server.

#### Frontend framework defaults

| Framework | Build command | Output dir | Notes |
|-----------|---------------|------------|-------|
| React | `npm run build` | `dist` or `build` | Create React App uses `build` |
| Vue | `npm run build` | `dist` | Vite default |
| Angular | `ng build` | `dist` | |
| Next.js | `npm run build` | `.next` | Use Vercel/Netlify native deploy for managed hosting |
| Svelte | `npm run build` | `public` | |
| Astro | `astro build` | `dist` | |
| Vanilla JS | *(none)* | `.` | Copies static files as-is |

---

## Walkthrough: Backend only

Backends always deploy to a **self-hosted target** (SSH, Docker, EC2, Azure VM, GCP VM, or Kubernetes).

### Init choices

| Prompt | Typical value |
|--------|----------------|
| What are you deploying? | **Backend only** |
| Language / framework | See table below |
| Start command | e.g. `npm start`, `uvicorn main:app …` |
| Port | e.g. 3000, 8000, 8080 |
| Storage | At least one provider |
| Configure deployment? | Yes for storage + deploy |
| Deployment type | ssh (most common), docker, ec2, kubernetes, … |
| App name | PM2 process name on server |
| Health check URL | e.g. `https://api.example.com/health` |

### Example: Express API → S3 + SSH

```bash
deployhub init
# Backend only → Node.js Express
# Start: npm start, port 3000
# Storage: AWS S3
# Configure deployment? Yes → ssh
# Host: 203.0.113.10, user: deploy, path: /var/www/my-api
# App name: my-api
# Health URL: https://api.example.com/health
```

On the server, ensure **Node.js**, **PM2**, and your app dependencies are available. DeployHub SSHs in, extracts the artifact, runs install if needed, and restarts PM2.

### Example: FastAPI → Dropbox + SSH

```bash
deployhub init
# Backend only → Python FastAPI
# Start: uvicorn main:app --host 0.0.0.0 --port 8000
# Storage: Dropbox
# Deploy: ssh
```

Server needs **Python 3.11+**, `pip`, and ideally **gunicorn/uvicorn** for production.

### Backend framework defaults

| Framework | Language | Build | Start | Port | Test |
|-----------|----------|-------|-------|------|------|
| Express | Node | — | `npm start` | 3000 | `npm test` |
| NestJS | Node | `nest build` | `node dist/main` | 3000 | `npm test` |
| Fastify / Koa | Node | — | `npm start` | 3000 | `npm test` |
| FastAPI | Python | — | `uvicorn main:app --host 0.0.0.0 --port 8000` | 8000 | `pytest` |
| Django | Python | — | `gunicorn config.wsgi:application --bind 0.0.0.0:8000` | 8000 | `python manage.py test` |
| Flask | Python | — | `gunicorn app:app --bind 0.0.0.0:5000` | 5000 | `pytest` |
| Laravel | PHP | — | `php artisan serve` | 80 | `php artisan test` |
| Symfony | PHP | — | `php-fpm` | 80 | `php bin/phpunit` |
| Spring Boot | Java | `mvn package` | `java -jar target/*.jar` | 8080 | `mvn test` |
| Go | Go | `go build -o bin/app .` | `./bin/app` | 8080 | `go test ./...` |
| .NET | C# | `dotnet publish -c Release -o publish` | `dotnet App.dll` | 5000 | `dotnet test` |
| Rails | Ruby | `bundle exec rake assets:precompile` | `bundle exec puma` | 3000 | `bundle exec rspec` |

**Node.js backends** without a build step still get packaged; set `buildCommand` to empty in config if you truly have no compile step.

**Java / Go / .NET** always run a compile step before artifact creation.

---

## Walkthrough: Full stack (frontend + backend)

Choose **Both (monorepo / fullstack)** when frontend and backend live in the **same repository root** (typical monorepo layout).

### Init flow

1. **Frontend** — framework, build command, output directory.
2. **Backend** — framework, start command, port.
3. **Storage** — one or more providers.
4. **Configure deployment?** → Yes.
5. **Frontend deploy path** — self-hosted SSH (static files + nginx).
6. **Backend deploy** — SSH, Docker, EC2, etc.

DeployHub runs **both** builds, packs them into one artifact, uploads once, then deploys frontend and backend to their respective server targets.

### Example: React + Express monorepo

```bash
deployhub init
# Both (monorepo / fullstack)
# Frontend: React, npm run build, dist
# Backend: Express, npm start, port 3000
# Storage: AWS S3 + Local
# Configure deployment? Yes
# Frontend: ssh → /var/www/my-app/public
# Backend: ssh → api.example.com, path /var/www/my-app/api, PM2 name my-app-api
```

**Secrets:** AWS + `SSH_*`

**Layout tip:** Keep `package.json` scripts for both apps at the repo root, or ensure build commands point to the correct paths (edit `deployhub.config.json` after init if your monorepo uses subfolders).

### Example: React + Express, both on one VPS

```bash
deployhub init
# Both → React + Express
# Frontend deploy: Self-hosted server
# Frontend path: /var/www/my-app/public
# Backend: ssh, path /var/www/my-app/api
```

DeployHub generates `nginx.conf` to serve static files and proxy API requests.

### Example: Next.js API routes only

Use **Frontend only** with **Next.js** and deploy via **SSH** or your platform's native git-push workflow — no separate backend entry needed.

---

## Framework defaults by language

### JavaScript / TypeScript (Node)

All JS frontends share the same install/build flow: `npm ci` → `npm run build` → artifact from output directory.

| Role | Frameworks |
|------|------------|
| Frontend | React, Vue, Angular, Next.js, Svelte, Astro, Vanilla |
| Backend | Express, NestJS, Fastify, Koa |

**Init is the same** for each; only default build/output/start commands differ (tables above).

### Python

- **Detect:** `requirements.txt` containing `fastapi`, `django`, or `flask`.
- **Install:** `pip install -r requirements.txt`
- **Test:** `pytest` (if `pytest.ini` exists) or Django test runner.
- **Build:** Usually skipped (`buildCommand: null`); artifact includes source + dependencies list.
- **Deploy (SSH):** Server must have Python + pip; start command runs uvicorn/gunicorn.

### PHP

- **Detect:** `composer.json` with `laravel/framework` or `symfony/framework-bundle`.
- **Install:** Composer (on CI and server).
- **Deploy:** SSH with PHP-FPM or `php artisan` for Laravel.

### Java

- **Detect:** `pom.xml` with Spring Boot.
- **Install/Build:** `mvn package` produces JAR in `target/`.
- **Deploy:** SSH runs `java -jar target/*.jar` (or your custom start command).

### Go

- **Detect:** `go.mod` present.
- **Build:** `go build -o bin/app .`
- **Artifact:** `bin/` binary + any config files.
- **Deploy:** SSH copies binary and restarts process.

### .NET

- **Detect:** `.csproj` in project root.
- **Build:** `dotnet publish -c Release -o publish`
- **Deploy:** SSH runs `dotnet YourApp.dll` from publish folder.

### Ruby

- **Detect:** `Gemfile` with `rails`.
- **Build:** `bundle exec rake assets:precompile` (for production assets).
- **Deploy:** SSH with `bundle exec puma` or your configured start command.

---

## GitHub Actions setup

After `init`, commit these files:

```bash
git add deployhub.config.json .github/workflows/deployhub.yml .env.example
git commit -m "Add DeployHub CI"
```

1. Open **Settings → Secrets and variables → Actions** in your GitHub repo.
2. Add every secret listed at the end of `deployhub init` (storage + deployment).
3. Push to `main` or `master` — the workflow triggers on push.

The workflow installs the correct language runtime (Node, Python, Java, Go, .NET, Ruby) based on your `deployhub.config.json`, installs DeployHub, runs `deployhub build`, and uses your secrets.

To run manually: **Actions → DeployHub → Run workflow**.

---

## Choosing storage providers

| Provider | Good for | Setup command |
|----------|----------|---------------|
| **Local** | Dev/testing, no cloud account | No credentials |
| **AWS S3** | Production, CI-friendly | `deployhub storage add aws` |
| **Google Drive** | Small teams, manual downloads | `deployhub storage add gdrive` |
| **Azure Blob** | Azure ecosystem | `deployhub storage add azure` |
| **GCP Storage** | GCP ecosystem | `deployhub storage add gcp` |
| **Dropbox** | Simple off-site backup | `deployhub storage add dropbox` |

You can enable **multiple providers** — DeployHub uploads to all of them in parallel on every build.

---

## Deployment target cheat sheet

| Project type | Frontend deploy options | Backend deploy options |
|--------------|-------------------------|------------------------|
| Frontend only | SSH/Docker/EC2/Azure VM/GCP VM/K8s | — |
| Backend only | — | SSH/Docker/EC2/Azure VM/GCP VM/K8s |
| Full stack | SSH (static + nginx) | SSH/Docker/EC2/K8s (always) |

| Mode | Storage | Deploy | When to use |
|------|---------|--------|-------------|
| **Storage only** | ✓ | ✗ | Backups, audit trail, manual releases |
| **Storage + deploy** | ✓ | ✓ | Full CI/CD |

---

## Minimal `deployhub.config.json` examples

### Storage only — React

```json
{
  "project": "my-react-app",
  "projectType": "frontend",
  "framework": "react",
  "buildCommand": "npm run build",
  "buildOutput": "dist",
  "storage": ["local", "aws"],
  "deploy": [],
  "pipeline": { "test": true, "deploy": false, "verify": false }
}
```

### Storage + deploy — FastAPI on SSH

```json
{
  "project": "my-api",
  "projectType": "backend",
  "framework": "fastapi",
  "language": "python",
  "startCommand": "uvicorn main:app --host 0.0.0.0 --port 8000",
  "port": 8000,
  "storage": ["aws"],
  "deploy": ["production"],
  "environments": {
    "production": {
      "deploymentType": "server",
      "type": "ssh",
      "host": "203.0.113.10",
      "user": "deploy",
      "deployPath": "/var/www/my-api",
      "appName": "my-api",
      "framework": "fastapi"
    }
  },
  "pipeline": { "deploy": true, "verify": true },
  "healthCheck": { "url": "https://api.example.com/health", "timeout": 30 }
}
```

Prefer `deployhub init` over hand-writing config — it sets adapters, workflow, and secrets list correctly.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Deploy requires storage upload` | Add at least one storage provider in config |
| AWS / GDrive check fails in `doctor` | Run `deployhub storage add <provider>` and match GitHub Secrets |
| SSH deploy fails | Verify `SSH_KEY` is the **private** key; user can write to deploy path |
| Wrong output uploaded | Fix `buildOutput` in config (`dist` vs `build` vs `.next`) |
| Tests fail in CI | Set `"pipeline": { "test": false }` temporarily, or fix tests |
| Monorepo subfolders | Edit `buildCommand` paths in `deployhub.config.json` after init |

Run `deployhub doctor` after any config change.

---

## Commands

| Command | Description |
|---------|-------------|
| `deployhub init` | Interactive project setup |
| `deployhub build` | Full pipeline: detect → install → test → build → artifact → storage → deploy |
| `deployhub artifact create` | Create artifact from current build |
| `deployhub artifact list` | List all artifacts |
| `deployhub artifact restore <version>` | Download and extract an artifact |
| `deployhub storage add <provider>` | Add storage provider credentials |
| `deployhub storage list` | List storage providers and connection status |
| `deployhub deploy` | Deploy latest artifact |
| `deployhub rollback [version]` | Rollback to a previous version |
| `deployhub logs` | Show logs from last deployment |
| `deployhub doctor` | Pre-flight checks |
| `deployhub verify` | Health check on configured endpoint |
| `deployhub clean` | Remove old local artifacts |
| `deployhub update` | Check for CLI updates |

## GitHub Secrets

Add these secrets in your repository (Settings → Secrets and variables → Actions). Only add secrets for providers you selected during `init`. At the end of `deployhub init`, DeployHub prints the exact list for your project.

### Storage

| Secret | Provider |
|--------|----------|
| `AWS_ACCESS_KEY_ID` | AWS S3 |
| `AWS_SECRET_ACCESS_KEY` | AWS S3 |
| `AWS_BUCKET` | AWS S3 |
| `AWS_REGION` | AWS S3 |
| `GDRIVE_CLIENT_ID` | Google Drive |
| `GDRIVE_CLIENT_SECRET` | Google Drive |
| `GDRIVE_REFRESH_TOKEN` | Google Drive |
| `GDRIVE_FOLDER_ID` | Google Drive |
| `AZURE_CONNECTION_STRING` | Azure Blob |
| `AZURE_CONTAINER` | Azure Blob |
| `GCP_PROJECT_ID` | GCP Storage |
| `GCP_KEY_FILE` | GCP Storage |
| `GCP_BUCKET` | GCP Storage |
| `DROPBOX_ACCESS_TOKEN` | Dropbox |
| `FTP_HOST`, `FTP_USER`, `FTP_PASSWORD` | FTP storage |

### Server deployment (SSH, EC2, VMs)

| Secret | Used for |
|--------|----------|
| `SSH_HOST` | Target server hostname |
| `SSH_USER` | SSH username |
| `SSH_KEY` | Private SSH key (PEM) |
| `SSH_DEPLOY_PATH` | Remote directory (optional if set in config) |
| `SSH_APP_NAME` | PM2 process name for backends |
| `SSH_PORT` | App port on server (optional) |

## `deployhub doctor` Output

The doctor command runs independent checks and always completes without crashing:

```
  Checking Git...               ✓ Git installed, repo detected, remote set
  Checking Docker...            ✓ Docker running
  Checking Build command...     ✓ "npm run build" found in package.json
  Checking AWS...               ✓ Credentials valid, bucket accessible
  Checking Google Drive...      ✓ Connected
  Checking SSH target...        ✓ Can reach host
  Checking Health endpoint...   ✓ URL reachable (HTTP 200)
  Checking Secrets...           ✓ All required env vars present
  Checking GitHub Actions...    ✓ Workflow file exists at .github/workflows/deployhub.yml
  Checking Storage write...     ✓ Test upload succeeded

  ✓ Ready to deploy (10/10 checks passed)
```

If checks fail:

```
  Checking AWS...               ✗ Missing: AWS_SECRET_ACCESS_KEY
  Checking Health endpoint...   ✗ No URL configured

  8/10 — fix the 2 issues above before deploying
```

## Artifact Structure

Each build creates:

```
artifact/
  {projectName}/
    {YYYY-MM-DD}/
      v{semver}/
        artifact.zip
        metadata.json
        logs.txt
        checksums.txt
        deployment.json
        release-notes.md
        README.md
```

`deployment.json` records server deployment metadata per environment:

```json
{
  "targets": ["production"],
  "deployedAt": "2026-07-01T12:00:00.000Z",
  "deployments": [
    {
      "environmentName": "production",
      "serverAddress": "203.0.113.10",
      "processId": "my-api",
      "timestamp": "2026-07-01T12:00:00.000Z"
    }
  ]
}
```

Rollback redeploys a previous artifact to the configured server targets using this metadata.

## Configuration

`deployhub.config.json` is generated by `init`. Credentials are **never** stored in this file — only in `.env` or GitHub Secrets.

## Pipeline Stages

1. **detect** — auto-detect project type
2. **install** — install dependencies
3. **test** — run test suite (skippable)
4. **build** — run build command
5. **docker** — build Docker image (skippable)
6. **artifact** — create artifact.zip + metadata
7. **storage** — upload to all configured providers (parallel)
8. **deploy** — deploy to configured targets
9. **verify** — health check after deployment
10. **notify** — send Slack/email/webhook notifications

## Author

**Akash Chowdhury**
📧 akashbumbac24@gmail.com
💼 [linkedin.com/in/akash-chowdhury-12141a222](https://www.linkedin.com/in/akash-chowdhury-12141a222/)

Built with ❤ — if DeployHub saves you time, feel free to connect on LinkedIn.

## License

MIT
