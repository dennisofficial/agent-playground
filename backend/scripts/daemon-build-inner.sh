#!/usr/bin/env bash
set -euo pipefail
# =============================================================================
# Runs INSIDE the generic base image (Linux), invoked by build-daemon.sh. Copies the read-only repo
# source (/src) into the persistent build volume (/build), then installs + builds so /build is a
# complete, Linux-native /repo tree the daemon runs from (mounted read-only at /daemon in each sandbox).
# The pnpm store is a separate persistent volume (/pnpm-store) so installs stay fast across runs.
# =============================================================================

log() { echo "[daemon-build] $*"; }

# Copy the WHOLE repo (the pnpm isolated/injected linker needs every workspace package present), minus
# the heavy/regenerated dirs. `--delete` keeps /build in sync with /src for tracked files; it does NOT
# touch excluded paths (node_modules/dist), so the persistent install survives between runs.
log "syncing source /src → /build…"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude '.agent-home' \
  --exclude '.workspaces' \
  --exclude '.worktrees' \
  --exclude '.turbo' \
  --exclude 'coverage' \
  --exclude 'web/.next' \
  /src/ /build/

cd /build

# The build volume PERSISTS and rsync EXCLUDES dist (so it never deletes stale dist) — clear generated
# output explicitly (Nest's nest-cli.json sets deleteOutDir:false, so stale daemon JS would otherwise
# linger in the volume and ship to sandboxes).
log "clearing stale dist output…"
rm -rf backend/dist shared/dist
rm -rf packages/*/dist 2>/dev/null || true

log "pnpm install (frozen lockfile, store=/pnpm-store)…"
pnpm install --frozen-lockfile --store-dir /pnpm-store

log "building house packages + @workspace/shared…"
pnpm --filter "./packages/**" run build
pnpm --filter "@workspace/shared" run build

log "compiling the daemon (nest build daemon)…"
pnpm --filter backend exec nest build daemon

if [ ! -f /build/backend/dist/daemon/main.js ]; then
  log "FATAL: /build/backend/dist/daemon/main.js missing after build"
  exit 1
fi
log "ok — daemon entry present: /build/backend/dist/daemon/main.js"

# Stamp a CONTENT version next to the entry: the sha256 of the built main.js. This changes IFF the built
# daemon changes, and is what a running sandbox self-reports (via the daemon's `version()` RPC) so the
# host's boot reconciliation can detect a stale sandbox (on an OLD daemon after a code change + restart)
# and `docker restart` it onto the freshly-built code. Written into the volume next to main.js so it ships
# with the mount and a restarted daemon naturally reports the new value (convergence).
log "stamping daemon build version (.build-version)…"
sha256sum /build/backend/dist/daemon/main.js | awk '{print $1}' \
  > /build/backend/dist/daemon/.build-version
log "ok — build version: $(cat /build/backend/dist/daemon/.build-version)"
