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
- Generate `.github/workflows/deployhub.yml` and `.github/workflows/deployhub-rollback.yml`
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
- `.github/workflows/deployhub.yml` — CI deploy pipeline (push to main)
- `.github/workflows/deployhub-rollback.yml` — manual CI rollback (`workflow_dispatch`)
- `.env.example` — list of env vars you may need
- `nginx.conf` — auto-generated if frontend deploys to SSH
- `Dockerfile` — auto-generated if missing and you chose Docker or Kubernetes deploy (your existing `Dockerfile` is never overwritten)
- `k8s/deployment.yaml` and `k8s/service.yaml` — auto-generated if missing and you chose Kubernetes deploy (existing manifests are never overwritten)

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
deployhub artifact list              # local artifacts
deployhub artifact list --remote     # include storage history.json
deployhub artifact restore <buildId> # download a past build

deployhub deploy                     # deploy latest artifact to defaultEnvironment
deployhub deploy --env staging       # deploy one named environment
deployhub deploy --env all           # every enabled environment (skips disabled)

deployhub rollback                   # previous build for defaultEnvironment
deployhub rollback --env production  # roll back one env using its own history
deployhub rollback 1.0.6-a1b2c3d --env staging
deployhub rollback --env all         # continue-on-error across enabled envs

deployhub env list                   # list environments (method, status, last deploy)
deployhub env add staging            # add an environment (interactive method prompts)
deployhub env enable staging         # include in deploy / --env all
deployhub env disable staging        # exclude without deleting config
deployhub env remove staging         # remove env (re-point defaultEnvironment first if needed)

deployhub sync-workflows             # regenerate deploy + rollback GitHub Actions YAML
deployhub sync-k8s-ports             # fix containerPort/targetPort in existing k8s manifests
deployhub logs                       # last deployment logs
```

### Rollback behavior

`deployhub rollback` restores a previous artifact from **that environment's** `envs/{env}/history.json` (legacy project `history.json` is treated as the default env's history) and redeploys it:

| Argument | Behavior |
|----------|----------|
| *(none)* | Rolls back to the **previous** build (second entry in newest-first history) |
| Exact `buildId` | Rolls back to that specific build **if it appears in that env's history** |
| Semver / version string matching **multiple** builds | Does **not** guess — prints the matching `buildId`s and exits; re-run with an exact one |

`buildId` looks like `{semver}-{stamp}` where the stamp is a short git SHA when available, otherwise a CI run id, otherwise a high-resolution timestamp. When `DOCKER_IMAGE_TAG` is left unset, Docker and Kubernetes use that same `buildId` as the image tag — so you can correlate an artifact in storage with the image that was pushed.

### Rollback is scoped per environment

Each environment maintains its own independent deploy history. When you roll back an environment, DeployHub only considers builds that were actually deployed **to that environment** — never builds deployed to a different environment, even if they're more recent or share the same project.

For example: if `development` has deployed builds A, C, and D (in that order), and `production` has separately deployed builds B and D, then rolling back `production` moves it from D to B — **not** to C, even though C is technically a more recent build overall, because C was never deployed to `production` in the first place.

You also cannot roll back an environment to a specific `buildId` that was never deployed to that environment — even with `deployhub rollback <buildId> --env <name>`, DeployHub will refuse if that buildId doesn't appear in that environment's own history. This guarantees every rollback returns an environment to a build that was genuinely running there before, never a build it never actually had.

Storage layout (per project):

```text
{project}/builds/{buildId}/artifact.zip          # immutable build blobs (shared)
{project}/envs/{env}/history.json                # that env's deploy history only
{project}/envs/{env}/latest/artifact.zip         # last successful deploy to that env
{project}/history.json                           # build catalog / legacy default-env history
```

For CI-triggered rollback, see [CI rollback](#ci-rollback-deployhub-rollbackyml).

---

## Multi-environment deployments

DeployHub supports multiple named environments in one project (e.g. `development` + `production`), each with its own method, secrets, trigger, and deploy history.

### Commands

```bash
deployhub env list
deployhub env add staging --method ssh          # or omit --method for interactive prompts
deployhub env enable staging
deployhub env disable staging
deployhub env remove staging

deployhub deploy --env staging
deployhub deploy --env all                      # every enabled environment

deployhub rollback --env production
deployhub rollback 1.2.3-abc1234 --env staging
deployhub rollback --env all                    # each env rolls back independently

deployhub sync-workflows                        # regenerate deployhub.yml + deployhub-rollback.yml
```

### Trigger defaults

| Situation | Default `trigger` |
|-----------|-------------------|
| Single-environment `init` | `"push"` — auto-deploy on push to main (original DeployHub behavior) |
| First / grandfathered env in multi-env `init` | `"push"` |
| Additional environments | `"manual"` — deploy only via Actions → Run workflow or `deployhub deploy --env` |

Multi-env `init` prints a reminder naming which environments are push vs manual and how to edit `deployhub.config.json` (`environments.<name>.trigger`) if you want a different mix. After changing triggers or envs, run `deployhub sync-workflows` and commit the regenerated YAML.

On a GitHub Actions **push**, `deployhub build` only auto-deploys environments with `trigger: "push"`. Environments with `trigger: "manual"` are never deployed on push — even though their secrets are present in the job for dispatch/rollback.

### Secret naming

| Environment | GitHub Secret / env var style |
|-------------|-------------------------------|
| Grandfathered / original (`unprefixedSecretEnvironment`) | Unprefixed: `SSH_HOST`, `SSH_KEY`, `DOCKER_IMAGE_NAME`, … |
| Every additional environment | Prefixed: `PRODUCTION_SSH_HOST`, `STAGING_DOCKER_IMAGE_NAME`, … |

Build and Dispatch workflow steps share the **same** secret set (all enabled environments). Trigger only controls which environments are deployed on push — not which secrets are injected.

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

Artifacts appear under `artifact/{projectName}/{date}/v{buildId}/` locally.

**Remote storage** (S3 and other providers) uses a different layout:

```text
{project}/builds/{buildId}/artifact.zip          # immutable per CI/build (shared across envs)
{project}/history.json                           # build catalog for artifact list --remote
{project}/latest/artifact.zip                    # last uploaded build (NOT a backup)
{project}/envs/{env}/history.json                # per-environment deploy history (rollback)
{project}/envs/{env}/latest/artifact.zip         # last deploy to that env (NOT a backup)
```

`buildId` is unique per pipeline run (e.g. `1.0.6-a1b2c3d`) even if `package.json` semver is unchanged. Legacy keys `{project}/v{semver}/artifact.zip` are no longer written; they remain readable for older uploads only. Build once, then promote the same `buildId` to any environment with `deployhub deploy --env`.

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
git add deployhub.config.json .github/workflows/deployhub.yml .github/workflows/deployhub-rollback.yml .env.example
git commit -m "Add DeployHub CI"
```

1. Open **Settings → Secrets and variables → Actions** in your GitHub repo.
2. Add every secret listed at the end of `deployhub init` (storage + deployment).
3. Push to `main` or `master` — the deploy workflow triggers on push.

The deploy workflow (`deployhub.yml`) installs the correct language runtime (Node, Python, Java, Go, .NET, Ruby) based on your `deployhub.config.json`, installs DeployHub, runs `deployhub build`, and uses your secrets.

To run a deploy manually: **Actions → DeployHub → Run workflow**.

### CI rollback (`deployhub-rollback.yml`)

`init` also generates a separate **DeployHub Rollback** workflow (`deployhub-rollback.yml`). It is triggered only via GitHub Actions' **Run workflow** button (not on push):

1. Open **Actions → DeployHub Rollback → Run workflow**.
2. Optionally enter an exact `buildId` (leave blank to roll back to the previous build).
3. Run the workflow.

Already-initialized projects that only have `deployhub.yml` will not get the rollback workflow from a re-run of unrelated commands — run **`deployhub sync-workflows`** once to regenerate both workflow files from your current `deployhub.config.json`, then commit and push.

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

## Choosing a deployment method

DeployHub supports six deployment targets. Pick based on what infrastructure you already have — DeployHub does not provision servers, VMs, or clusters for you.

| Method | Best for | You need already |
|--------|----------|------------------|
| **ssh** | Any Linux VPS or bare-metal server you control | Server with SSH, key pair, app runtime |
| **docker** | Containerized apps (Dockerfile or docker-compose.yml) | Docker locally or on a remote host |
| **ec2** | AWS users with an existing EC2 instance | Running EC2 instance, security group, key pair |
| **azure-vm** | Azure users with an existing virtual machine | Running Azure VM, NSG allowing SSH |
| **gcp-vm** | GCP users with an existing Compute Engine VM | Running VM, firewall rule for SSH, metadata SSH key |
| **kubernetes** | Teams with an existing K8s cluster | Cluster, kubectl access; manifests auto-generated if missing |

---

## Deployment method guides

Each method below follows the same structure: **prerequisites** (before `deployhub init`), **what DeployHub automates**, **after init** (matches terminal output), and a **variable reference**.

### One-time server setup (before your first deploy)

SSH-based methods (SSH, EC2, Azure VM, GCP VM) require a few one-time steps on the server **before your first deploy**. DeployHub does not silently change ownership or sudo policy for you.

SSH into your server once and run:

```bash
sudo mkdir -p /var/www/your-app-name
sudo chown your-ssh-user:your-ssh-user /var/www/your-app-name
```

Replace `/var/www/your-app-name` with your actual deploy path and `your-ssh-user` with your configured `SSH_USER` (e.g. `ec2-user` on Amazon Linux, `ubuntu` on Ubuntu). Without this, DeployHub cannot write your build output — `deployhub doctor` will catch it and show the exact fix.

**Frontend deploys** that auto-activate `nginx.conf` also need **passwordless sudo** for Nginx test/reload (and `cp` into `/etc/nginx/`). After installing Nginx, run `sudo visudo` and add a line like:

```bash
your-ssh-user ALL=(ALL) NOPASSWD: /usr/sbin/nginx, /bin/cp, /usr/bin/cp, /bin/systemctl, /usr/bin/systemctl
```

> **Security note:** This example grants broad privileges — unrestricted `cp` (any source/destination) and `systemctl` (any unit/action), not just Nginx. That keeps setup simple but is a significant trust boundary. For production, prefer a dedicated deploy user and a **narrow wrapper script** (e.g. `/usr/local/bin/deployhub-nginx-reload` that only copies to your project's config path and runs `nginx -t` + reload), then grant `NOPASSWD` only for that script. The line above is a starting point for dev/test servers; tighten it before production.

Install Nginx if it is not already present:

- **Amazon Linux / RHEL:** `sudo yum install -y nginx && sudo systemctl enable --now nginx`
- **Ubuntu / Debian:** `sudo apt install -y nginx`

DeployHub detects whether the server uses Debian-style `sites-available` or RHEL-style `conf.d` at deploy time and writes a **uniquely named** config file for your project only — it does not overwrite unrelated Nginx configs.

### SSH

**Verification:** Real-world verified DEPLOY and ROLLBACK.

**Prerequisites (before `deployhub init`):**
- [ ] Complete **[one-time server setup](#one-time-server-setup-before-your-first-deploy)** (deploy path ownership + Nginx/sudo for frontends)
- [ ] A Linux server with SSH enabled
- [ ] Private SSH key file (.pem/.key) and public key in `authorized_keys`
- [ ] Port 22 open in firewall for your IP
- [ ] Deploy directory writable by your SSH user (e.g. `sudo mkdir -p /var/www/my-app && sudo chown ubuntu:ubuntu /var/www/my-app` — `/var/www` is root-owned on most fresh Linux images)
- [ ] App runtime on server (Node.js, Python, etc.) for backends

**What DeployHub automates:**
- Complete `.env.example` with commented variables
- SSH key permission check (offers to `chmod 600`)
- SSH connectivity test during `init`
- Deploy path write-permission check during `deployhub doctor`
- Nginx layout detection (Debian `sites-available` vs RHEL `conf.d`) at deploy time
- Nginx config test (`nginx -t`) before reload
- Passwordless sudo and Nginx checks during `deployhub doctor` (frontend)
- Artifact upload, extract, app restart (PM2, gunicorn, etc.)

**After `init`:**
1. Ensure port 22 is open in your server firewall
2. Ensure your deploy directory exists and is owned by your SSH user (see prerequisite above if `deployhub doctor` reports permission denied)
3. Copy `.env.example` → `.env`; set `SSH_HOST`, `SSH_USER`, `SSH_KEY_PATH`
4. Add GitHub Secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY` (paste private key for CI)
5. Run `deployhub doctor`
6. `git push origin main`

| Variable | Description | Example | Where to get it |
|----------|-------------|---------|-----------------|
| `SSH_HOST` | Server IP or hostname | `203.0.113.10` | Your hosting provider dashboard |
| `SSH_USER` | SSH login user | `ubuntu` | AMI/image docs (Ubuntu→ubuntu, Amazon Linux→ec2-user) |
| `SSH_KEY_PATH` | Path to private key file | `~/.ssh/my-key.pem` | Downloaded when server was created |
| `SSH_SSH_PORT` | SSH port (optional) | `22` | Server SSH config |
| `SSH_DEPLOY_PATH` | Remote deploy directory | `/var/www/my-app` | Your server layout |
| `SSH_APP_NAME` | PM2 process name (backend) | `my-api` | Your choice |
| `SSH_PORT` | App listen port (backend) | `3000` | Your app config |
| `SSH_KEY` | Private key contents (CI only) | `-----BEGIN...` | Same key as `SSH_KEY_PATH` |

### Docker

**Verification:** Real-world verified DEPLOY and ROLLBACK (local and CI).

**Prerequisites:**
- [ ] Docker installed (`docker --version` works)
- [ ] Registry account if pushing private images
- [ ] `docker-compose.yml` in project if you use multi-service Compose (not auto-generated)

**What DeployHub automates:**
- Starter `Dockerfile` at project root when none exists (framework-aware; skipped if you already have one)
- `.dockerignore` when missing (never overwrites an existing one)
- `.env.example` for image name, registry, remote `DOCKER_HOST`
- Docker daemon connectivity test during `init`
- Reuses the image built in the pipeline `docker` stage when present; otherwise builds from the artifact
- Registry login + push when `DOCKER_REGISTRY_USERNAME` / `DOCKER_REGISTRY_TOKEN` are set
- Auto-generates a unique image tag per build when `DOCKER_IMAGE_TAG` is unset (git SHA → CI run id → timestamp)
- `docker compose up` or build/push/run during deploy

**After `init`:**
1. Set `DOCKER_IMAGE_NAME` in `.env` (e.g. `myuser/myapp` for Docker Hub)
2. For private registries (or any push): set `DOCKER_REGISTRY_USERNAME` and `DOCKER_REGISTRY_TOKEN`
3. Leave `DOCKER_IMAGE_TAG` unset for a unique tag each build — set it only if you intentionally want a fixed tag
4. For remote Docker: set `DOCKER_HOST` (e.g. `ssh://ubuntu@203.0.113.10`)
5. Run `deployhub doctor`, then `git push origin main`

| Variable | Description | Example | Where to get it |
|----------|-------------|---------|-----------------|
| `DOCKER_IMAGE_NAME` | Image repository path | `myorg/myapp` | Your registry naming |
| `DOCKER_IMAGE_TAG` | Optional fixed tag (unset → unique per build) | `latest` | Your choice; prefer unset |
| `DOCKER_REGISTRY_URL` | Registry URL (optional) | `https://ghcr.io` | Registry docs |
| `DOCKER_REGISTRY_USERNAME` | Registry user | `myuser` | Registry account |
| `DOCKER_REGISTRY_TOKEN` | Registry password/token | *(secret)* | Docker Hub / GHCR PAT |
| `DOCKER_HOST` | Remote daemon (optional) | `ssh://ubuntu@host` | Remote Docker setup |

### AWS EC2

**Verification:** Real-world verified DEPLOY and ROLLBACK.

**Prerequisites:**
- [ ] Complete **[one-time server setup](#one-time-server-setup-before-your-first-deploy)** (`ec2-user` on Amazon Linux)
- [ ] EC2 instance launched in AWS Console (DeployHub does not create it)
- [ ] Key pair `.pem` downloaded at launch
- [ ] Security group: inbound SSH (22) from your IP
- [ ] Deploy directory writable by your SSH user (e.g. `sudo mkdir -p /var/www/my-app && sudo chown ec2-user:ec2-user /var/www/my-app` — `/var/www` is root-owned on Amazon Linux by default)
- [ ] App runtime on instance for backends

**What DeployHub automates:**
- EC2-specific `.env.example` (SSH + optional AWS API vars)
- SSH key validation and connectivity test
- Deploy path write-permission check during `deployhub doctor`
- Nginx layout detection and config test before reload (frontend)
- Passwordless sudo and Nginx checks during `deployhub doctor` (frontend)
- OS user suggestion from AMI hint (ubuntu, ec2-user)
- Optional public IP lookup via `EC2_INSTANCE_ID` + AWS CLI

**After `init`:**
1. AWS Console → EC2 → Security Groups → Inbound rules → SSH port 22 from My IP
2. Ensure your deploy directory exists and is owned by your SSH user (see prerequisite above if `deployhub doctor` reports permission denied)
3. Copy `.env.example` → `.env`; set `SSH_KEY_PATH`, `SSH_HOST` (or `EC2_INSTANCE_ID` + AWS creds)
4. GitHub Secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, plus `AWS_*` if using instance ID lookup
5. Run `deployhub doctor`, then `git push origin main`

| Variable | Description | Example | Where to get it |
|----------|-------------|---------|-----------------|
| `SSH_HOST` | Instance public IP/DNS | `54.123.45.67` | EC2 Console → Instances |
| `SSH_USER` | SSH user for AMI | `ec2-user` | AMI documentation |
| `SSH_KEY_PATH` | Path to .pem key | `~/.ssh/ec2-key.pem` | Downloaded at instance launch |
| `EC2_INSTANCE_ID` | Instance ID (optional) | `i-0abc123...` | EC2 Console |
| `AWS_ACCESS_KEY_ID` | AWS key for API lookup | `AKIA...` | IAM → Users → Security credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS secret | *(secret)* | Same as above |
| `AWS_REGION` | Instance region | `us-east-1` | EC2 Console top bar |

### Azure VM

**Verification:** Real-world verified DEPLOY. Rollback logic confirmed via shared-SSH-path audit; not yet live-tested independently.

**Prerequisites:**
- [ ] Complete **[one-time server setup](#one-time-server-setup-before-your-first-deploy)** (`azureuser` or your VM login user)
- [ ] Azure VM created in Portal (DeployHub does not provision it)
- [ ] NSG rule allowing inbound SSH (port 22)
- [ ] SSH public key on the VM
- [ ] Deploy directory writable by your SSH user (e.g. `sudo mkdir -p /var/www/my-app && sudo chown azureuser:azureuser /var/www/my-app`)
- [ ] App runtime for backends

**What DeployHub automates:**
- Azure VM `.env.example` with SSH + optional Azure API vars
- Auto-detects subscription ID via `az` CLI if logged in
- SSH key validation and connectivity test
- Deploy path write-permission check during `deployhub doctor`
- Nginx layout detection and config test before reload (frontend)
- Passwordless sudo and Nginx checks during `deployhub doctor` (frontend)

**After `init`:**
1. Azure Portal → VM → Networking → allow SSH (22) from your IP
2. Ensure your deploy directory exists and is owned by your SSH user (see prerequisite above if `deployhub doctor` reports permission denied)
3. Copy `.env.example` → `.env`; set `SSH_HOST`, `SSH_USER`, `SSH_KEY_PATH`
4. For CI: add `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` as GitHub Secrets
5. Run `deployhub doctor`, then `git push origin main`

| Variable | Description | Example | Where to get it |
|----------|-------------|---------|-----------------|
| `SSH_HOST` | VM public IP | `20.1.2.3` | Azure Portal → VM overview |
| `SSH_USER` | SSH username | `azureuser` | Chosen at VM creation |
| `SSH_KEY_PATH` | Private key path | `~/.ssh/azure.pem` | Your key file |
| `AZURE_SUBSCRIPTION_ID` | Subscription (optional) | `uuid` | `az account show` |
| `AZURE_RESOURCE_GROUP` | Resource group | `my-app-rg` | Portal → Resource groups |
| `AZURE_VM_NAME` | VM name | `my-vm` | Portal → Virtual machines |

### GCP VM

**Verification:** Real-world verified DEPLOY. Rollback logic confirmed via shared-SSH-path audit; not yet live-tested independently.

**Prerequisites:**
- [ ] Complete **[one-time server setup](#one-time-server-setup-before-your-first-deploy)** (your GCP SSH username)
- [ ] Compute Engine VM created (DeployHub does not create it)
- [ ] Firewall rule allowing `tcp:22` (default `default-allow-ssh` may exist)
- [ ] SSH public key in **Metadata → SSH Keys** (GCP uses metadata keys, not launch key pairs like AWS)
- [ ] Deploy directory writable by your SSH user (e.g. `sudo mkdir -p /var/www/my-app && sudo chown $USER:$USER /var/www/my-app`)
- [ ] App runtime for backends

**What DeployHub automates:**
- GCP VM `.env.example` with SSH + optional GCP API vars
- Auto-detects project ID via `gcloud` if authenticated
- SSH key validation and connectivity test
- Deploy path write-permission check during `deployhub doctor`
- Nginx layout detection and config test before reload (frontend)
- Passwordless sudo and Nginx checks during `deployhub doctor` (frontend)

**After `init`:**
1. GCP Console → VPC → Firewall → ensure SSH (tcp:22) allowed from your IP
2. Add SSH public key: Console → Compute Engine → Metadata → SSH Keys
3. Ensure your deploy directory exists and is owned by your SSH user (see prerequisite above if `deployhub doctor` reports permission denied)
4. Copy `.env.example` → `.env`; set `SSH_HOST`, `SSH_USER`, `SSH_KEY_PATH`
5. Run `deployhub doctor`, then `git push origin main`

| Variable | Description | Example | Where to get it |
|----------|-------------|---------|-----------------|
| `SSH_HOST` | External IP | `34.56.78.90` | Compute Engine → VM instances |
| `SSH_USER` | SSH username | `your_google_username` | GCP OS Login or metadata |
| `SSH_KEY_PATH` | Private key path | `~/.ssh/gcp-key` | Your local key pair |
| `SSH_SSH_PORT` | SSH connection port (optional) | `22` | Server SSH config |
| `SSH_DEPLOY_PATH` | Remote deploy directory (optional) | `/var/www/my-app` | Your server layout |
| `SSH_APP_NAME` | PM2 process name (backend) | `my-api` | Your choice |
| `SSH_PORT` | App listen port (backend) | `3000` | Your app config |
| `SSH_KEY` | Private key contents (CI only) | `-----BEGIN...` | Same key as `SSH_KEY_PATH` |
| `GCP_PROJECT_ID` | Project ID (optional) | `my-project-123` | `gcloud config get-value project` |
| `GCP_ZONE` | VM zone (optional) | `us-central1-a` | VM instance details |
| `GCP_INSTANCE_NAME` | Instance name (optional) | `my-vm` | Compute Engine list |
| `GCP_KEY_FILE` | Service account JSON (optional, CI) | `/path/to/key.json` | IAM → Service Accounts → Keys |

### Kubernetes

**Verification:** Real-world verified DEPLOY and ROLLBACK (including k3s and CI).

**Prerequisites:**
- [ ] Existing Kubernetes cluster (DeployHub does not provision clusters)
- [ ] `kubectl` installed and configured on your **local machine** (for `deployhub doctor` / manual `deployhub deploy`)
- [ ] Cluster reachable from CI (kubeconfig **secret contents** or cloud auth — see `KUBECONFIG` below)
- [ ] Container registry credentials so the cluster can pull the image you push

**Init prompts (what `deployhub init` asks for Kubernetes):**
1. Path to kubeconfig file (e.g. `~/.kube/config`)
2. Kubernetes context
3. Namespace (defaults to project name)
4. Container image name
5. Registry URL (leave empty for Docker Hub)
6. Registry username (required to push)
7. Registry token/password (required to push)
8. Health check URL (optional)

**What DeployHub automates:**
- Starter `k8s/deployment.yaml` and `k8s/service.yaml` when no manifests exist (skipped if you already have a `k8s/` directory or root-level Kubernetes YAML files)
- GitHub Actions installs `kubectl` on the CI runner and writes kubeconfig from secrets (no local `kubectl` required for the automated push-to-main deploy path)
- Lists `kubectl` contexts during `init` for easy selection
- Auto-detects `~/.kube/config`
- Complete `.env.example` for kubeconfig, context, namespace, and registry settings
- Cluster connectivity test during `init`
- On deploy: registry login → reuse or build image → push (unique tag unless `DOCKER_IMAGE_TAG` is set) → ensure namespace exists (prompt locally / auto-create in CI) → `kubectl apply` → `kubectl set image` with the full resolved image ref → `kubectl rollout restart` when that ref is unchanged so pods pick up a new digest

> **Limitation — multiple Kubernetes clusters:** A generated workflow writes **one** kubeconfig file per job. Multiple Kubernetes environments that target **different clusters** in the same workflow run are not yet fully supported (follow-up). Same-cluster multi-namespace / multi-env is fine.

**After `init`:**
1. Verify context: `kubectl config get-contexts`
2. Copy `.env.example` → `.env`; set `DOCKER_IMAGE_NAME`, registry username/token, and (for local deploys) `KUBECONFIG` / `KUBE_CONTEXT` / `KUBE_NAMESPACE` as needed
3. Leave `DOCKER_IMAGE_TAG` unset for a unique tag each build — set it only if you want a fixed tag (DeployHub will still rollout-restart when the full image ref is unchanged)
4. Namespace is created on first deploy if missing (you will be prompted locally; CI auto-creates). Or create it yourself: `kubectl create namespace my-app`
5. For private registries: create an `imagePullSecret` and set `KUBE_IMAGE_PULL_SECRET`
6. Add GitHub Secrets for CI (see table — **`KUBECONFIG` must be the file contents, not a path**)
7. Run `deployhub doctor`, then `git push origin main`

> **Ports in generated Kubernetes manifests:** `containerPort` and `targetPort` are derived from your project's Dockerfile `EXPOSE` line (frontend / nginx images correctly get **80**; backends get their real exposed port). If no Dockerfile or usable `EXPOSE` exists yet, DeployHub falls back to a per-project-type default that matches its Dockerfile templates. Fresh `init` does **not** require a manual port edit. The Service's external `port:` stays **80** for all project types by design (Ingress-friendly); only the internal `targetPort` / `containerPort` track the container. Already-initialized projects with stale `3000` values can run `deployhub sync-k8s-ports` to patch just those fields.

| Variable | Description | Example | Where to get it |
|----------|-------------|---------|-----------------|
| `KUBECONFIG` | **Local:** path to kubeconfig. **CI (GitHub Secret):** full kubeconfig **file contents** (or base64) — not a path | `~/.kube/config` locally; paste file contents in CI | `~/.kube/config` |
| `KUBE_CONTEXT` | Context name | `my-cluster` | `kubectl config get-contexts` |
| `KUBE_NAMESPACE` | Target namespace (optional; defaults to project name) | `my-app` | Your choice |
| `DOCKER_IMAGE_NAME` | Container image repository | `myuser/myapp` or `ghcr.io/org/app` | Your registry |
| `DOCKER_IMAGE_TAG` | Optional fixed tag (unset → unique per build) | `latest` | Prefer unset |
| `DOCKER_REGISTRY_URL` | Registry URL (optional; empty = Docker Hub) | `https://ghcr.io` | Registry docs |
| `DOCKER_REGISTRY_USERNAME` | Registry user (required to push) | `myuser` | Registry account |
| `DOCKER_REGISTRY_TOKEN` | Registry password/token (required to push) | *(secret)* | Docker Hub token / GHCR PAT |
| `KUBE_IMAGE_PULL_SECRET` | Pull secret name (optional, private registries) | `regcred` | `kubectl create secret docker-registry` |

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
| SSH deploy fails | Verify `SSH_KEY_PATH` points to your private `.pem` file (or `SSH_KEY` in CI); user can write to deploy path; port 22 open |
| Wrong output uploaded | Fix `buildOutput` in config (`dist` vs `build` vs `.next`) |
| Tests fail in CI | Set `"pipeline": { "test": false }` temporarily, or fix tests |
| Monorepo subfolders | Edit `buildCommand` paths in `deployhub.config.json` after init |

Run `deployhub doctor` after any config change.

---

## Commands

| Command | Description |
|---------|-------------|
| `deployhub init` | Interactive project setup (one or multiple environments) |
| `deployhub build` | Full pipeline: detect → install → test → build → artifact → storage → deploy (default / push-triggered envs) |
| `deployhub artifact create` | Create artifact from current build |
| `deployhub artifact list [--remote]` | List local artifacts; `--remote` merges storage `history.json` |
| `deployhub artifact restore <buildId\|semver>` | Download and extract an artifact |
| `deployhub storage add <provider>` | Add storage provider credentials |
| `deployhub storage list` | List storage providers and connection status |
| `deployhub deploy` | Deploy latest artifact to `defaultEnvironment` |
| `deployhub deploy --env staging` | Deploy to one named environment |
| `deployhub deploy --env all` | Deploy to every enabled environment (skips disabled) |
| `deployhub rollback` | Roll back `defaultEnvironment` to its previous build |
| `deployhub rollback --env production` | Roll back one env from `envs/{env}/history.json` |
| `deployhub rollback <buildId> --env staging` | Restore an exact `buildId` to that environment |
| `deployhub rollback --env all` | Roll back each enabled env (continue-on-error + summary) |
| `deployhub env list` | List environments (method, enabled, trigger, last deploy) |
| `deployhub env add <name>` | Add an environment (interactive method prompts; regenerates workflows) |
| `deployhub env enable <name>` | Enable an environment for deploy / `--env all` |
| `deployhub env disable <name>` | Disable without deleting config |
| `deployhub env remove <name>` | Remove an environment (re-point `defaultEnvironment` first if needed) |
| `deployhub sync-workflows` | Regenerate `.github/workflows/deployhub.yml` and `deployhub-rollback.yml` from config |
| `deployhub sync-k8s-ports` | Update only `containerPort` / `targetPort` in `k8s/deployment.yaml` and `k8s/service.yaml` from Dockerfile `EXPOSE` (or config/fallback). Does **not** change replicas, resources, env, or probes. Heavily customized / multi-container manifests may need a manual review |
| `deployhub logs` | Show logs from last deployment |
| `deployhub doctor [--all]` | Pre-flight checks per environment (`--all` includes disabled envs as informational) |
| `deployhub verify` | Health check on configured endpoint |
| `deployhub clean` | Remove old local artifacts |
| `deployhub update` | Check for CLI updates |

**Tests:** `npm test` — currently **320 passing** across the Jest suites.

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

### Server deployment (SSH, EC2, VMs, Docker, Kubernetes)

| Secret | Used for |
|--------|----------|
| `SSH_HOST` | Target server hostname or IP |
| `SSH_USER` | SSH username |
| `SSH_KEY_PATH` | Local path to private key (`.env` only) |
| `SSH_KEY` | Private key contents (GitHub Actions / CI) |
| `SSH_SSH_PORT` | SSH connection port (default 22) |
| `SSH_DEPLOY_PATH` | Remote directory (optional if set in config) |
| `SSH_APP_NAME` | PM2 process name for backends |
| `SSH_PORT` | App port on server (backend) |
| `EC2_INSTANCE_ID`, `AWS_*` | Optional EC2 dynamic IP lookup |
| `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_VM_NAME` | Optional Azure VM IP lookup |
| `GCP_PROJECT_ID`, `GCP_ZONE`, `GCP_INSTANCE_NAME`, `GCP_KEY_FILE` | Optional GCP VM IP lookup |
| `DOCKER_IMAGE_NAME`, `DOCKER_REGISTRY_USERNAME`, `DOCKER_REGISTRY_TOKEN`, `DOCKER_REGISTRY_URL`, `DOCKER_HOST` | Docker deployment (`DOCKER_IMAGE_TAG` optional) |
| `KUBECONFIG`, `KUBE_CONTEXT`, `KUBE_NAMESPACE`, `DOCKER_IMAGE_NAME`, `DOCKER_REGISTRY_USERNAME`, `DOCKER_REGISTRY_TOKEN`, `DOCKER_REGISTRY_URL`, `DOCKER_IMAGE_TAG`, `KUBE_IMAGE_PULL_SECRET` | Kubernetes — **`KUBECONFIG` in GitHub Secrets must be the kubeconfig file contents (or base64), not a filesystem path**. `DOCKER_IMAGE_TAG`, `KUBE_NAMESPACE`, `DOCKER_REGISTRY_URL`, and `KUBE_IMAGE_PULL_SECRET` are optional |

**Kubernetes rollback vs deploy — registry credentials:** Kubernetes **rollback** specifically **requires** `DOCKER_REGISTRY_USERNAME` and `DOCKER_REGISTRY_TOKEN`. Rollback rebuilds and must push a fresh image tagged with the restored `buildId`; without registry credentials it fails loudly and early (a rollback that cannot push can never succeed against a real cluster). This is stricter than a normal Kubernetes **deploy**, which may still allow local-only / no-push flows in some setups. If deploy worked without those secrets but rollback fails asking for them, that asymmetry is intentional.

See [Deployment method guides](#deployment-method-guides) for full per-method variable tables with examples.

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
  Checking Rollback workflow... ✓ Missing .github/workflows/deployhub-rollback.yml — run deployhub sync-workflows to add CI rollback (workflow_dispatch)
  Checking Storage write...     ✓ Test upload succeeded

  ✓ Ready to deploy (11/11 checks passed)
```

The **Rollback workflow** check is informational and non-blocking (`✓` even when the file is missing). It suggests `deployhub sync-workflows` so already-initialized projects can pick up `deployhub-rollback.yml` without a full re-init. When the file exists, the message confirms the path instead.

If checked-in workflow files exist but are **out of date** with `deployhub.config.json` (e.g. you ran `env add` or a silent migration and forgot `sync-workflows`), doctor also reports an informational **Workflow sync** nudge naming the missing environment or secret and suggesting `deployhub sync-workflows`. That check never fails the doctor exit code.

If checks fail:

```
  Checking AWS...               ✗ Missing: AWS_SECRET_ACCESS_KEY
  Checking Health endpoint...   ✗ No URL configured

  8/10 — fix the 2 issues above before deploying
```

## Artifact Structure

Each build creates a **local** directory:

```
artifact/
  {projectName}/
    {YYYY-MM-DD}/
      v{buildId}/
        artifact.zip
        metadata.json
        logs.txt
        checksums.txt
        deployment.json
        release-notes.md
        README.md
```

`buildId` looks like `{semver}-{gitSha|ciId|timestamp}` (unique every pipeline run).

**Remote keys** (all storage providers):

```
{project}/builds/{buildId}/artifact.zip          # immutable per CI/build (shared across envs)
{project}/history.json                           # build catalog for artifact list --remote
{project}/latest/artifact.zip                    # overwritten every build — convenience pointer only
{project}/envs/{env}/history.json                # per-environment deploy history (rollback)
{project}/envs/{env}/latest/artifact.zip         # last deploy to that env (NOT a backup)
```

Legacy (read-only fallback, no longer written): `{project}/v{semver}/artifact.zip`

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
