#!/usr/bin/env bash
# Build the v3 sandbox image (self-contained multi-stage build — the engine bundle is built INSIDE the
# image from the monorepo source) and push it to the k3d-managed local registry. This is the deploy step;
# run it alongside `pnpm db:migrate` whenever the engine or image changes.
#
# The build context is the REPO ROOT (the builder stage installs the whole pnpm workspace); the Dockerfile
# lives at backend/sandbox/Dockerfile. Pods pull the pushed image via imagePullPolicy: Always.
set -euo pipefail

# NOT 5000 — macOS Control Center (AirPlay Receiver) occupies it; must match dev-cluster:up's registry port.
REGISTRY_PORT="${ATLAS_REGISTRY_PORT:-5111}"
# Push target is the registry's HOST-mapped address; pods reference the same image via k3d-<name>:<port>.
PUSH_REF="${SANDBOX_PUSH_IMAGE:-localhost:${REGISTRY_PORT}/atlas-sandbox:latest}"

# Repo root = two levels up from backend/scripts/.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[build-and-push] building ${PUSH_REF} (context ${ROOT})"
docker build -f "${ROOT}/backend/sandbox/Dockerfile" -t "${PUSH_REF}" "${ROOT}"

echo "[build-and-push] pushing ${PUSH_REF}"
docker push "${PUSH_REF}"

echo "[build-and-push] done. Pods pull k3d-atlas-registry:${REGISTRY_PORT}/atlas-sandbox:latest (SANDBOX_IMAGE)."
