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
REGISTRY_NAME="${ATLAS_REGISTRY_NAME:-atlas-registry}"

# Repo root = two levels up from backend/scripts/.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# IMMUTABLE per-build tag so a running pod can tell "my build ≠ current build" and recreate on the next turn
# (SandboxService.ensureReady). git short-sha; a dirty tree gets a unique suffix so repeated dev rebuilds differ.
TAG="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo nogit)"
[ -n "$(git -C "${ROOT}" status --porcelain 2>/dev/null)" ] && TAG="${TAG}-dirty-$(date +%s)"

# Push to the registry's HOST-mapped address; pods reference the SAME image via the in-cluster registry name.
PUSH_REF="${SANDBOX_PUSH_IMAGE:-localhost:${REGISTRY_PORT}/atlas-sandbox:${TAG}}"
POD_REF="k3d-${REGISTRY_NAME}:${REGISTRY_PORT}/atlas-sandbox:${TAG}"

echo "[build-and-push] building ${PUSH_REF} (context ${ROOT})"
docker build -f "${ROOT}/backend/sandbox/Dockerfile" -t "${PUSH_REF}" "${ROOT}"

echo "[build-and-push] pushing ${PUSH_REF}"
docker push "${PUSH_REF}"

# Point the host at this immutable build: update-or-append SANDBOX_IMAGE in the gitignored plaintext override
# file so the next host (re)start picks it up via env:inject. Running pods then recreate on their next turn.
ENV_PERSONAL="${ROOT}/backend/.env.personal"
touch "${ENV_PERSONAL}"
if grep -q '^SANDBOX_IMAGE=' "${ENV_PERSONAL}"; then
  # portable in-place edit (BSD/macOS sed needs the empty backup arg)
  sed -i.bak "s|^SANDBOX_IMAGE=.*|SANDBOX_IMAGE=${POD_REF}|" "${ENV_PERSONAL}" && rm -f "${ENV_PERSONAL}.bak"
else
  printf 'SANDBOX_IMAGE=%s\n' "${POD_REF}" >> "${ENV_PERSONAL}"
fi

echo "[build-and-push] done. SANDBOX_IMAGE=${POD_REF} written to backend/.env.personal — restart the host to apply."
