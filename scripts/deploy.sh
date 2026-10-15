#!/usr/bin/env bash
# Deploy on a server that has a git checkout of this repo:
#   bash scripts/deploy.sh            (run from anywhere; it cd's to the repo root)
#
# 1. git pull origin main      2. npm ci --omit=dev      3. zero-downtime reload
# Reload: PM2 when installed (cluster-friendly `pm2 reload`), otherwise Phusion Passenger (touch tmp/restart.txt).
#
# NOTE: the live Hostinger site is deployed from an archive (node scripts/package-deploy.js, then upload + build in
# hPanel or through the Hostinger API), not from a git checkout: there this script does not apply. Use it on a VPS
# or any host where the repository is cloned. It never touches .env or the database.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -f .env ] || echo "warning: no .env here; the environment must provide DB_*, JWT_SECRET, ..." >&2

echo "==> git pull origin main"
git pull --ff-only origin main

echo "==> npm ci --omit=dev"
npm ci --omit=dev

echo "==> reload"
if command -v pm2 >/dev/null 2>&1; then
  if [ -f ecosystem.config.js ]; then
    pm2 reload ecosystem.config.js --env production --update-env
  else
    pm2 reload all --update-env
  fi
else
  mkdir -p tmp
  touch tmp/restart.txt
  echo "pm2 not found: asked Passenger to restart the app (tmp/restart.txt)"
fi

echo "==> done: $(git rev-parse --short HEAD)"
