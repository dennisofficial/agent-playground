#!/usr/bin/env bash
# PID 1 of an Atlas v3 sandbox pod. Start the inner dockerd (DinD) so the agent can `docker compose up`
# its own Postgres / dev stack and boot the repo's app, then exec the requested command (default: idle).
# Host drives engine turns via `kubectl exec` into the running pod, one per turn (see SandboxService).
#
# Requires the container to run privileged (buildPodSpec sets it). Storage driver: overlay2 (fast, thin
# layers) is used when /var/lib/docker sits on a normal fs; vfs (slow, full copies, but works anywhere) is
# the fallback when it sits on overlayfs — the kernel rejects overlay2-on-overlayfs. S2a finding: with a
# dedicated emptyDir (or S2b PVC) mounted at /var/lib/docker, that mount is ext4 on k3d/Docker Desktop, so
# overlay2 works. Auto-detected below; force either with ATLAS_DOCKERD_STORAGE_DRIVER=overlay2|vfs.
set -uo pipefail
log() { echo "[entrypoint] $*"; }

# overlay2 unless /var/lib/docker is itself overlayfs (then overlay2 can't stack — use vfs).
pick_storage_driver() {
  if [ -n "${ATLAS_DOCKERD_STORAGE_DRIVER:-}" ]; then echo "${ATLAS_DOCKERD_STORAGE_DRIVER}"; return; fi
  case "$(stat -f -c %T /var/lib/docker 2>/dev/null)" in
    overlayfs) echo vfs ;;
    *) echo overlay2 ;;
  esac
}

start_dockerd() {
  local driver; driver="$(pick_storage_driver)"
  log "starting inner dockerd (storage-driver=${driver})"
  dockerd --storage-driver="${driver}" >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      log "inner dockerd ready"
      # Single-tenant-per-sandbox: open the socket so a non-root exec user can drive inner docker without
      # per-uid group juggling (the container is already privileged).
      chmod 666 /var/run/docker.sock 2>/dev/null || true
      return 0
    fi
    sleep 1
  done
  log "WARN inner dockerd not ready after 60s — see /var/log/dockerd.log"
  return 0
}

if [ "${ATLAS_SANDBOX_DIND:-1}" = "1" ]; then
  start_dockerd || true
else
  log "DinD disabled (ATLAS_SANDBOX_DIND=0)"
fi

log "ready"
if [ "$#" -gt 0 ]; then
  exec "$@"
else
  exec sleep infinity
fi
