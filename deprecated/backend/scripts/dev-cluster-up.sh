#!/usr/bin/env bash
# DEV ONLY — k3d is the local emulation of prod (where k3s is installed directly on the host). Brings up the
# ISOLATED local Atlas sandbox cluster: a k3d cluster + a k3d-managed image registry, with the $ATLAS_DATA
# storage root bind-mounted into the node so pod hostPath mounts are durable across reaps.
#
# Named `atlas` / `atlas-registry` so it NEVER touches the user's other k3d clusters or contexts. k3d runs
# its k3s node as a privileged container, so the in-pod privileged dockerd (DinD) works with no extra flags.
# Re-runnable: skips create if the cluster/registry already exist.
set -euo pipefail

CLUSTER="${ATLAS_CLUSTER:-atlas}"
REGISTRY_NAME="${ATLAS_REGISTRY_NAME:-atlas-registry}"   # in-cluster host becomes k3d-<name>
# NOT 5000 — macOS Control Center (AirPlay Receiver) listens there, so k3d can't use it on a Mac.
REGISTRY_PORT="${ATLAS_REGISTRY_PORT:-5111}"
NAMESPACE="${K8S_NAMESPACE:-atlas-sandboxes}"
# Default under the repo (gitignored `backend/.atlas-data`), NOT /tmp: macOS Docker Desktop doesn't share
# /tmp into its VM, so a /tmp bind mount is a phantom (the node gets an empty copy). $HOME/repo paths ARE
# shared. Kept relative for portability (matches the backend's ATLAS_DATA); absolutized below since k3d
# --volume needs an absolute source.
ATLAS_DATA="${ATLAS_DATA:-./.atlas-data}"

# The storage root must exist on the host before k3d bind-mounts it into the node.
mkdir -p "${ATLAS_DATA}/workspaces" "${ATLAS_DATA}/state" "${ATLAS_DATA}/homes" "${ATLAS_DATA}/cache"
ATLAS_DATA="$(cd "${ATLAS_DATA}" && pwd)"

if k3d registry list 2>/dev/null | grep -q "k3d-${REGISTRY_NAME}"; then
  echo "[cluster-up] registry 'k3d-${REGISTRY_NAME}' already exists — skipping create"
else
  echo "[cluster-up] creating registry k3d-${REGISTRY_NAME} (host localhost:${REGISTRY_PORT})"
  k3d registry create "${REGISTRY_NAME}" --port "${REGISTRY_PORT}"
fi

if k3d cluster list -o json 2>/dev/null | grep -q "\"name\":\"${CLUSTER}\""; then
  echo "[cluster-up] cluster '${CLUSTER}' already exists — skipping create"
else
  echo "[cluster-up] creating k3d cluster '${CLUSTER}' (bind-mount ${ATLAS_DATA}, use registry k3d-${REGISTRY_NAME}:${REGISTRY_PORT})"
  # --volume ...@all: same host path inside every node, so pod hostPath mounts are durable.
  # --registry-use: the cluster trusts + pulls from the k3d-managed registry (imagePullPolicy: Always).
  k3d cluster create "${CLUSTER}" \
    --servers 1 --agents 0 --wait \
    --volume "${ATLAS_DATA}:${ATLAS_DATA}@all" \
    --registry-use "k3d-${REGISTRY_NAME}:${REGISTRY_PORT}"
fi

echo "[cluster-up] ensuring namespace ${NAMESPACE}"
kubectl --context "k3d-${CLUSTER}" get namespace "${NAMESPACE}" >/dev/null 2>&1 \
  || kubectl --context "k3d-${CLUSTER}" create namespace "${NAMESPACE}"

kubectl --context "k3d-${CLUSTER}" get nodes
cat <<EOF
[cluster-up] done.
  context      : k3d-${CLUSTER}
  registry     : push to  localhost:${REGISTRY_PORT}/atlas-sandbox:latest
                 pods use k3d-${REGISTRY_NAME}:${REGISTRY_PORT}/atlas-sandbox:latest  (= SANDBOX_IMAGE default)
  storage root : ${ATLAS_DATA}  (set ATLAS_DATA in the host env to match)
Next: ./build-and-push.sh
EOF
