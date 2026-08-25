#!/usr/bin/env bash
# DEV ONLY (k3d — prod uses host-installed k3s). Tear down ONLY the isolated Atlas sandbox cluster +
# registry — never the user's other k3d clusters.
# The $ATLAS_DATA storage root on the host is left intact (delete it manually to wipe durable worktrees).
set -euo pipefail

CLUSTER="${ATLAS_CLUSTER:-atlas}"
REGISTRY_NAME="${ATLAS_REGISTRY_NAME:-atlas-registry}"

echo "[cluster-down] deleting k3d cluster '${CLUSTER}'"
k3d cluster delete "${CLUSTER}" || true
echo "[cluster-down] deleting registry 'k3d-${REGISTRY_NAME}'"
k3d registry delete "k3d-${REGISTRY_NAME}" || true
echo "[cluster-down] done (host \$ATLAS_DATA left intact)"
