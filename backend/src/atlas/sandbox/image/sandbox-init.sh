#!/usr/bin/env bash
# PID 1 of an Atlas v2 sandbox. Start the inner dockerd (DinD) so the agent can `docker compose up`
# its own Postgres / dev stack, then idle — engine turns are `docker exec`'d in by the host, one per
# turn. Requires the container to run --privileged with a volume at /var/lib/docker (so the inner
# overlay2 sits on a real fs, not overlay-on-overlay).
set -uo pipefail
log() { echo "[sandbox-init] $*"; }

start_dockerd() {
  log "starting inner dockerd"
  dockerd >/var/log/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      log "inner dockerd ready"
      # Family-trust single-tenant-per-sandbox: open the socket so the host-uid exec user can drive
      # inner docker without per-uid group juggling (the container is already privileged).
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

log "ready; awaiting exec turns"
exec sleep infinity
