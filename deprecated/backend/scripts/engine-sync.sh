#!/usr/bin/env bash
# Engine hotswap: build the engine bundle and sync it into $ATLAS_DATA/engine-bundle — the host dir pods mount at
# /usr/local/lib/atlas/engine when SANDBOX_ENGINE_HOTSWAP=true. Since each turn re-execs the bundle, the next turn
# runs the fresh code with NO docker rebuild and NO pod restart, so the sandbox's running processes survive.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"                 # backend/
ATLAS_DATA="${ATLAS_DATA:-${ROOT}/.atlas-data}"
DEST="$(cd "$(dirname "${ATLAS_DATA}")" && pwd)/$(basename "${ATLAS_DATA}")/engine-bundle"

echo "[engine-sync] building engine bundle"
pnpm --dir "${ROOT}" build:engine

echo "[engine-sync] syncing bundle → ${DEST}"
mkdir -p "${DEST}"
# Mirror the bundle (chunks + .map included); --delete keeps stale chunks from lingering across rebuilds. rsync
# writes each file atomically (temp + rename), so a turn can't read a half-written engine-app.js.
rsync -a --delete "${ROOT}/dist/engine-bundle/" "${DEST}/"

echo "[engine-sync] done. With SANDBOX_ENGINE_HOTSWAP=true, the next turn runs this bundle."
