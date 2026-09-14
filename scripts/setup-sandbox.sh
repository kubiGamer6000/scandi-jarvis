#!/usr/bin/env bash
# One-time setup for Jarvis's local sandbox (JARVIS_SANDBOX_PROVIDER=local).
#
#   sudo bash scripts/setup-sandbox.sh            # system packages + toolchain
#   bash scripts/setup-sandbox.sh --tools-only    # (re)build the toolchain only, no sudo
#
# What it does:
#   1. apt: bubblewrap + CLI tools the skills use (poppler, qpdf, pandoc, tesseract).
#   2. AppArmor: Ubuntu 24.04 blocks unprivileged user namespaces by default
#      (kernel.apparmor_restrict_unprivileged_userns=1). This adds a profile
#      that lets /usr/bin/bwrap — and only bwrap — create them.
#   3. Toolchain at $SANDBOX_DIR/tools, mounted read-only inside the sandbox:
#      a Python venv (pypdf, pdfplumber, reportlab, python-docx, …) and
#      node_modules (docx). Built as the app user, never root.
#
# Env overrides: APP_DIR (default /opt/scandi-jarvis), APP_USER (default: owner
# of APP_DIR), SANDBOX_DIR (default $APP_DIR/.sandbox), WITH_LIBREOFFICE=1.

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/scandi-jarvis}
SANDBOX_DIR=${SANDBOX_DIR:-$APP_DIR/.sandbox}
TOOLS_DIR="$SANDBOX_DIR/tools"

PY_PACKAGES=(
  pypdf pdfplumber reportlab pypdfium2 pdf2image pytesseract pillow
  python-docx openpyxl pandas defusedxml lxml
)
NODE_PACKAGES=(docx)

build_tools() {
  echo "==> toolchain in $TOOLS_DIR"
  mkdir -p "$TOOLS_DIR/node"
  if [ ! -x "$TOOLS_DIR/venv/bin/python" ]; then
    python3 -m venv "$TOOLS_DIR/venv"
  fi
  "$TOOLS_DIR/venv/bin/pip" install --quiet --upgrade pip
  "$TOOLS_DIR/venv/bin/pip" install --quiet --upgrade "${PY_PACKAGES[@]}"
  (
    cd "$TOOLS_DIR/node"
    [ -f package.json ] || echo '{"private":true}' > package.json
    npm install --silent --no-audit --no-fund "${NODE_PACKAGES[@]}"
  )
  echo "    python: $("$TOOLS_DIR/venv/bin/python" --version)"
  echo "    node packages: ${NODE_PACKAGES[*]}"
}

if [ "${1:-}" = "--tools-only" ]; then
  build_tools
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo (or pass --tools-only to rebuild just the toolchain)" >&2
  exit 1
fi
APP_USER=${APP_USER:-$(stat -c %U "$APP_DIR")}

echo "==> apt packages"
apt-get update -qq
packages=(bubblewrap python3-venv poppler-utils qpdf pandoc tesseract-ocr)
if [ "${WITH_LIBREOFFICE:-0}" = "1" ]; then
  packages+=(libreoffice-writer-nogui)
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}"

if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  echo "==> AppArmor profile for bwrap"
  cat > /etc/apparmor.d/bwrap <<'EOF'
# Allow bubblewrap to create unprivileged user namespaces (Jarvis sandbox).
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
EOF
  apparmor_parser -r /etc/apparmor.d/bwrap
fi

echo "==> sandbox dir $SANDBOX_DIR (owner $APP_USER)"
install -d -o "$APP_USER" -g "$APP_USER" "$SANDBOX_DIR"

export -f build_tools
export TOOLS_DIR PY_PACKAGES_STR="${PY_PACKAGES[*]}" NODE_PACKAGES_STR="${NODE_PACKAGES[*]}"
sudo -u "$APP_USER" -H bash -c '
  set -euo pipefail
  read -ra PY_PACKAGES <<< "$PY_PACKAGES_STR"
  read -ra NODE_PACKAGES <<< "$NODE_PACKAGES_STR"
  build_tools
'

echo "==> self-test"
sudo -u "$APP_USER" bwrap --unshare-all --ro-bind /usr /usr --symlink usr/bin /bin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev \
  /bin/sh -c 'echo "    bubblewrap OK"'

echo
echo "Done. Restart Jarvis (jarvis restart) and look for \"Local sandbox ready\" in jarvis logs."
