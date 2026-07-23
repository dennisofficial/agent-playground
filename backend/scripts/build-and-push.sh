#!/usr/bin/env bash
# Build the v3 sandbox image (self-contained multi-stage build — the engine bundle is built INSIDE the
# image from the monorepo source) and push it to the k3d-managed local registry under the `:latest` tag.
# This is the deploy step; run it alongside `pnpm db:migrate` whenever the engine or image changes.
#
# The image identity is the DIGEST, not the tag. SANDBOX_IMAGE stays a constant `:latest` ref; at each turn
# start SandboxService.ensureReady resolves what digest `:latest` currently points to and recreates a running
# pod whose digest no longer matches. So a rebuild+push is picked up on the next turn with NO host restart —
# and never mid-turn (the recreate only runs pre-turn, before the engine SDK is launched).
#
# The build context is the REPO ROOT (the builder stage installs the whole pnpm workspace); the Dockerfile
# lives at backend/sandbox/Dockerfile. Pods pull by digest via imagePullPolicy: Always.
set -euo pipefail

# NOT 5000 — macOS Control Center (AirPlay Receiver) occupies it; must match dev-cluster:up's registry port.
REGISTRY_PORT="${ATLAS_REGISTRY_PORT:-5111}"
REGISTRY_NAME="${ATLAS_REGISTRY_NAME:-atlas-registry}"

# Repo root = two levels up from backend/scripts/.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Push to the registry's HOST-mapped address; pods reference the SAME image via the in-cluster registry name.
PUSH_REF="${SANDBOX_PUSH_IMAGE:-localhost:${REGISTRY_PORT}/atlas-sandbox:latest}"
POD_REF="k3d-${REGISTRY_NAME}:${REGISTRY_PORT}/atlas-sandbox:latest"

echo "[build-and-push] building ${PUSH_REF} (context ${ROOT})"
docker build -f "${ROOT}/backend/sandbox/Dockerfile" -t "${PUSH_REF}" "${ROOT}"

echo "[build-and-push] pushing ${PUSH_REF}"
docker push "${PUSH_REF}"

# SANDBOX_IMAGE is a CONSTANT `:latest` ref (matches the env default) — pin it in the gitignored override so a
# stale per-build tag from an older deploy can't linger. No restart is needed to adopt a new build: the digest
# resolved from this same tag changes, and ensureReady recreates stale pods on their next turn.
ENV_PERSONAL="${ROOT}/backend/.env.personal"
touch "${ENV_PERSONAL}"
if grep -q '^SANDBOX_IMAGE=' "${ENV_PERSONAL}"; then
  # portable in-place edit (BSD/macOS sed needs the empty backup arg)
  sed -i.bak "s|^SANDBOX_IMAGE=.*|SANDBOX_IMAGE=${POD_REF}|" "${ENV_PERSONAL}" && rm -f "${ENV_PERSONAL}.bak"
else
  printf 'SANDBOX_IMAGE=%s\n' "${POD_REF}" >> "${ENV_PERSONAL}"
fi

echo "[build-and-push] done. Pushed ${PUSH_REF}; running pods recreate on their next turn (digest change) — no host restart needed."
