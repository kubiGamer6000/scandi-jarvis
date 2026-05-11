#!/usr/bin/env bash
# Atomic deploy for scandi-jarvis on the production droplet.
# Pull → install (if lockfile changed) → build → restart → tail logs.
#
# Run as the `scandi` user. The matching sudoers rule (see docs/DEPLOYMENT.md
# §3.5) makes `sudo systemctl restart scandi-jarvis*` passwordless.
#
# Exit codes:
#   0  success or already-up-to-date
#   1  any step failed (set -e)

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/scandi-jarvis}
UNIT=${UNIT:-scandi-jarvis}
CRON_UNIT=${CRON_UNIT:-scandi-jarvis-cron.timer}
BRANCH=${BRANCH:-main}

cd "$APP_DIR"

echo "==> git fetch"
git fetch --quiet origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Already up to date ($LOCAL). Nothing to deploy."
  exit 0
fi

echo "==> git pull --ff-only (from $LOCAL → $REMOTE)"
git pull --ff-only origin "$BRANCH"

# Only run `npm ci` when the lockfile actually changed — saves 30-60s on
# code-only deploys.
if git diff --quiet "$LOCAL" "$REMOTE" -- package-lock.json package.json; then
  echo "==> deps unchanged, skipping npm ci"
else
  echo "==> npm ci"
  npm ci
fi

echo "==> npm run build"
npm run build

echo "==> restart $UNIT"
sudo systemctl restart "$UNIT"

# Restart the summary cron's *service* unit too if the timer is installed,
# so it picks up the new code on its next firing. (The .timer is fine as-is.)
if systemctl list-unit-files --no-legend | grep -q "^${CRON_UNIT%.timer}.service"; then
  echo "==> cron unit $CRON_UNIT will pick up new code on next fire"
fi

echo
echo "==> health"
sleep 2  # give Fastify a moment to bind
if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
  curl -fsS http://127.0.0.1:3000/health | sed 's/^/    /'
else
  echo "    health endpoint not yet responding — tailing logs for clues:"
fi

echo
echo "==> tail (Ctrl-C to stop)"
sudo journalctl -u "$UNIT" -f -n 30
