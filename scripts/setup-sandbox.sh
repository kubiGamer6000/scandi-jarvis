#!/usr/bin/env bash
# One-time setup for Jarvis's local sandbox (JARVIS_SANDBOX_PROVIDER=local).
#
#   sudo bash scripts/setup-sandbox.sh            # system packages + toolchain
#   bash scripts/setup-sandbox.sh --tools-only    # (re)build the toolchain only, no sudo
#
# What it does:
#   1. apt: bubblewrap + CLI tools the skills use (poppler, qpdf, pandoc,
#      tesseract, LibreOffice for xlsx recalculation and pptx/docx rendering).
#   2. AppArmor: Ubuntu 24.04 blocks unprivileged user namespaces by default
#      (kernel.apparmor_restrict_unprivileged_userns=1). This adds a profile
#      that lets /usr/bin/bwrap — and only bwrap — create them.
#   3. Toolchain at $SANDBOX_DIR/tools, mounted read-only inside the sandbox:
#      a Python venv (pypdf, pdfplumber, reportlab, python-docx, python-pptx,
#      openpyxl, markitdown, …) and node_modules (tsx for the Scandi kit
#      scripts, docx, pptxgenjs, react-icons + sharp). Built as the app user.
#
# Env overrides: APP_DIR (default /opt/scandi-jarvis), APP_USER (default: owner
# of APP_DIR), SANDBOX_DIR (default $APP_DIR/.sandbox), WITH_LIBREOFFICE=0 to skip
# LibreOffice (~400 MB; the xlsx/pptx skills need it to recalculate and render).

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/scandi-jarvis}
SANDBOX_DIR=${SANDBOX_DIR:-$APP_DIR/.sandbox}
TOOLS_DIR="$SANDBOX_DIR/tools"

PY_PACKAGES=(
  pypdf pdfplumber reportlab pypdfium2 pdf2image pytesseract pillow
  python-docx python-pptx openpyxl pandas defusedxml lxml "markitdown[pptx,docx,xlsx]"
)
NODE_PACKAGES=(tsx docx pptxgenjs react react-dom react-icons sharp)

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
packages=(bubblewrap python3-venv poppler-utils qpdf pandoc tesseract-ocr fonts-dejavu fonts-liberation)
if [ "${WITH_LIBREOFFICE:-1}" = "1" ]; then
  packages+=(libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui)
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

# Re-invoke this script as the app user (sudo strips exported shell functions,
# so calling build_tools through `sudo bash -c` doesn't work).
sudo -u "$APP_USER" -H env APP_DIR="$APP_DIR" SANDBOX_DIR="$SANDBOX_DIR" \
  bash "$(readlink -f "$0")" --tools-only

echo "==> self-test"
sudo -u "$APP_USER" bwrap --unshare-all --ro-bind /usr /usr --symlink usr/bin /bin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev \
  /bin/sh -c 'echo "    bubblewrap OK"'

echo
echo "Done. Restart Jarvis (jarvis restart) and look for \"Local sandbox ready\" in jarvis logs."
