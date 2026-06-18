#!/usr/bin/env bash
set -euo pipefail
# =============================================================================
# pnpm daemon:build — build the GENERIC workspace base image (if needed) and (re)populate the
# daemon-build volume with a Linux-built daemon (dist + node_modules + @workspace dists).
#
# ONE command for local AND deployed updates: edit daemon code → `pnpm daemon:build` → restart the
# workspace daemon (the build is mounted read-only at /daemon; no image rebuild). Incremental: a frozen
# lockfile + a persistent pnpm-store volume make `pnpm install` a near-no-op when nothing changed, so
# only `nest build` re-runs. Platform-safe: the build happens INSIDE the Linux base image, so a Mac host
# still produces correct Linux-native native binaries.
# =============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${WORKSPACE_IMAGE:-agent-workspace-base}"
BUILD_VOLUME="${WORKSPACE_DAEMON_BUILD_VOLUME:-agent-daemon-build}"
STORE_VOLUME="${WORKSPACE_PNPM_STORE_VOLUME:-agent-pnpm-store}"

log() { echo "[daemon:build] $*"; }

# 1) Base image (generic, no repo baked) — build if missing or REBUILD_IMAGE=1.
if [ "${REBUILD_IMAGE:-0}" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "building base image $IMAGE…"
  docker build -f "$REPO_ROOT/backend/src/daemon/Dockerfile" -t "$IMAGE" "$REPO_ROOT"
else
  log "base image $IMAGE present (set REBUILD_IMAGE=1 to force a rebuild)"
fi

# 2) Persistent volumes (build output + pnpm store).
docker volume create "$BUILD_VOLUME" >/dev/null
docker volume create "$STORE_VOLUME" >/dev/null

# 3) Build the daemon INTO the volume, inside the base image. `--entrypoint bash` overrides the image's
#    daemon entrypoint so this run is purely the build script (the source is mounted read-only at /src).
log "building daemon into volume $BUILD_VOLUME (store $STORE_VOLUME)…"
docker run --rm \
  --entrypoint bash \
  -v "$REPO_ROOT":/src:ro \
  -v "$BUILD_VOLUME":/build \
  -v "$STORE_VOLUME":/pnpm-store \
  "$IMAGE" \
  /src/backend/scripts/daemon-build-inner.sh

log "done — daemon build is in volume $BUILD_VOLUME (mounted read-only at /daemon in every sandbox)."
