#!/bin/sh
# DeployHub install script
# Author: Akash Chowdhury — canonical source: src/utils/author.js
# Repository: https://github.com/Akash-Chowdhury-24/DeployHub

set -e

GITHUB_REPO="Akash-Chowdhury-24/DeployHub"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="deployhub"

detect_platform() {
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"

  case "$OS" in
    linux)
      case "$ARCH" in
        x86_64|amd64) PLATFORM="linux" ;;
        *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
      esac
      ;;
    darwin)
      case "$ARCH" in
        x86_64) PLATFORM="macos" ;;
        arm64|aarch64) PLATFORM="macos-arm64" ;;
        *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
      esac
      ;;
    *)
      echo "Unsupported OS: $OS. Use install.ps1 on Windows." >&2
      exit 1
      ;;
  esac
}

fetch_latest_version() {
  if command -v curl >/dev/null 2>&1; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1)
  elif command -v wget >/dev/null 2>&1; then
    VERSION=$(wget -qO- "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1)
  else
    echo "curl or wget is required to download DeployHub." >&2
    exit 1
  fi

  if [ -z "$VERSION" ]; then
    echo "Could not determine latest release version. Falling back to npm install." >&2
    npm install -g deployhub@latest
    echo "DeployHub installed via npm."
    exit 0
  fi
}

download_binary() {
  ASSET="deployhub-${PLATFORM}"
  URL="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/${ASSET}"
  TMP="$(mktemp)"

  echo "Downloading DeployHub ${VERSION} (${PLATFORM})..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$TMP"
  else
    wget -qO "$TMP" "$URL"
  fi

  if [ ! -s "$TMP" ]; then
    echo "Binary download failed. Falling back to npm install." >&2
    rm -f "$TMP"
    npm install -g deployhub@latest
    echo "DeployHub installed via npm."
    exit 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    install -m 755 "$TMP" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    if command -v sudo >/dev/null 2>&1; then
      sudo install -m 755 "$TMP" "${INSTALL_DIR}/${BINARY_NAME}"
    else
      mkdir -p "${HOME}/.local/bin"
      install -m 755 "$TMP" "${HOME}/.local/bin/${BINARY_NAME}"
      echo "Installed to ${HOME}/.local/bin/${BINARY_NAME} — ensure it is on your PATH"
    fi
  fi

  rm -f "$TMP"
}

detect_platform
fetch_latest_version
download_binary

echo "DeployHub ${VERSION} installed successfully."
deployhub --version 2>/dev/null || true
