#!/bin/sh
# DeployHub install script
# Author: Akash Chowdhury — canonical source: src/utils/author.js
# Repository: https://github.com/Akash-Chowdhury-24/DeployHub

set -e

GITHUB_REPO="Akash-Chowdhury-24/DeployHub"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="deployhub"
NPM_PACKAGE="@akash-chowdhury-24/deployhub"
INSTALLED_PATH=""

detect_platform() {
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"

  case "$OS" in
    linux)
      case "$ARCH" in
        x86_64|amd64) PLATFORM="linux-x64" ;;
        *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
      esac
      ;;
    darwin)
      case "$ARCH" in
        x86_64) PLATFORM="macos-x64" ;;
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
    npm install -g "${NPM_PACKAGE}@latest"
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
    npm install -g "${NPM_PACKAGE}@latest"
    echo "DeployHub installed via npm."
    exit 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    install -m 755 "$TMP" "${INSTALL_DIR}/${BINARY_NAME}"
    INSTALLED_PATH="${INSTALL_DIR}/${BINARY_NAME}"
  else
    if command -v sudo >/dev/null 2>&1; then
      sudo install -m 755 "$TMP" "${INSTALL_DIR}/${BINARY_NAME}"
      INSTALLED_PATH="${INSTALL_DIR}/${BINARY_NAME}"
    else
      mkdir -p "${HOME}/.local/bin"
      install -m 755 "$TMP" "${HOME}/.local/bin/${BINARY_NAME}"
      INSTALLED_PATH="${HOME}/.local/bin/${BINARY_NAME}"
      echo "Installed to ${HOME}/.local/bin/${BINARY_NAME} — ensure it is on your PATH"
    fi
  fi

  rm -f "$TMP"
}

# Compare PATH-resolved `deployhub` to the binary we just installed.
warn_path_collision() {
  EXPECTED_VERSION="${VERSION#v}"
  if [ -z "$INSTALLED_PATH" ] || [ ! -x "$INSTALLED_PATH" ]; then
    return 0
  fi

  INSTALL_BIN_DIR="$(dirname "$INSTALLED_PATH")"
  # Put install dir on PATH only if missing, and APPEND (do not prepend).
  # Prepending would hide an older npm-global install that sits earlier on PATH —
  # the same failure mode the Windows installer hit.
  case ":${PATH}:" in
    *":${INSTALL_BIN_DIR}:"*) ;;
    *) PATH="${PATH}:${INSTALL_BIN_DIR}"; export PATH ;;
  esac

  DIRECT_OUT="$("$INSTALLED_PATH" --version 2>/dev/null || true)"
  DIRECT_VER="$(printf '%s\n' "$DIRECT_OUT" | head -n 1 | tr -d '\r' | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[-0-9A-Za-z.]*\).*/\1/p')"

  echo ""
  echo "Installed binary reports: ${DIRECT_VER:-unknown} ($INSTALLED_PATH)"

  if ! command -v deployhub >/dev/null 2>&1; then
    echo "Note: 'deployhub' is not yet visible on PATH in this shell."
    echo "Open a NEW terminal, then run: deployhub --version"
    return 0
  fi

  RESOLVED_PATH="$(command -v deployhub)"
  PATH_OUT="$(deployhub --version 2>/dev/null || true)"
  PATH_VER="$(printf '%s\n' "$PATH_OUT" | head -n 1 | tr -d '\r' | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[-0-9A-Za-z.]*\).*/\1/p')"

  # Resolve symlinks where possible for a fair path comparison.
  # Prefer `realpath` (GNU coreutils; also present on recent macOS).
  # Do NOT use `readlink -f` — that flag is GNU-only; BSD readlink on macOS
  # rejects `-f` (the `|| echo` fallback usually masks it, but it is not portable).
  INST_REAL="$INSTALLED_PATH"
  RES_REAL="$RESOLVED_PATH"
  if command -v realpath >/dev/null 2>&1; then
    INST_REAL="$(realpath "$INSTALLED_PATH" 2>/dev/null || echo "$INSTALLED_PATH")"
    RES_REAL="$(realpath "$RESOLVED_PATH" 2>/dev/null || echo "$RESOLVED_PATH")"
  fi

  if [ "$INST_REAL" = "$RES_REAL" ] && [ -n "$PATH_VER" ] && [ "$PATH_VER" = "$EXPECTED_VERSION" ]; then
    echo "PATH resolves to the newly installed binary ($PATH_VER). OK."
    echo "Still open a NEW terminal before day-to-day use so your shell profile PATH applies cleanly."
    return 0
  fi

  echo ""
  echo "WARNING: Installed DeployHub ${EXPECTED_VERSION} to ${INSTALLED_PATH},"
  echo "  but running 'deployhub --version' currently resolves to a DIFFERENT"
  echo "  installation reporting a different version (or path)."
  echo ""
  echo "  Expected:  ${INST_REAL}  (${EXPECTED_VERSION})"
  echo "  Resolved:  ${RES_REAL}  (${PATH_VER:-unknown version})"
  echo ""
  echo "  This usually means an older install (e.g. via 'npm install -g') is earlier in your PATH."
  echo ""
  echo "  To see every 'deployhub' on your PATH, run:"
  echo "    type -a deployhub"
  echo "    # or: which -a deployhub"
  echo ""
  echo "  To remove a conflicting npm install:"
  echo "    npm uninstall -g ${NPM_PACKAGE}"
  echo ""
  echo "  Or reorder your PATH so the directory containing the new binary comes first."
  echo ""
  echo "  This check uses the CURRENT shell PATH (install dir appended only if it was"
  echo "  missing — not prepended, so earlier npm installs are not hidden). After fixing"
  echo "  PATH, open a NEW terminal and run: deployhub --version"
}

detect_platform
fetch_latest_version
download_binary

echo "DeployHub ${VERSION} installed successfully."
warn_path_collision
