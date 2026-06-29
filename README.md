# DeployHub

Zero-configuration deployment and artifact manager for Node.js projects. When you push to GitHub, DeployHub automatically detects your project type, builds it, creates a versioned artifact, uploads to cloud storage, and optionally deploys to your server.

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
- Optionally configure deployment targets (SSH, Docker, EC2, Kubernetes, etc.)
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

Add these secrets in your repository (Settings → Secrets and variables → Actions). Only add secrets for providers you selected during `init`:

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
| `SSH_HOST` | SSH deployment |
| `SSH_USER` | SSH deployment |
| `SSH_KEY` | SSH deployment |

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
