#!/usr/bin/env bash
# PID 1 of an Atlas v2 sandbox. Start the inner dockerd (DinD) so the agent can `docker compose up`
# its own Postgres / dev stack, then idle — engine turns are `docker exec`'d in by the host, one per
# turn. Requires the container to run --privileged with a volume at /var/lib/docker (so the inner
# overlay2 sits on a real fs, not overlay-on-overlay).
#
# This is the home for built-in, sandbox-lifetime Atlas infrastructure (each a detached `start_<svc>()`
# launched below, e.g. dockerd and the persistent mcp-hub) — contrast with `atlas-svc`, which is for the
# OPERATOR's own user-facing app processes only (dev server, app-under-test), started on demand by the
# agent, never from here.
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

# The persistent MCP HUB — a built-in Atlas service (NOT atlas-svc). It connects ONCE per sandbox to all of
# the sandbox's user-defined MCP servers (stdio spawn / http+sse handshake), caches their tools, and serves
# each on a local loopback route the per-turn engine attaches to instantly (see image/mcp-hub-server.ts).
# This is what makes user MCP servers connect once per SANDBOX instead of once per TURN — killing both the
# per-turn re-spawn cost and the remote-connect race that left tools absent at turn-1. It reads its config
# (host-written union of the sandbox's servers) from /.atlas/mcp-hub.json on boot + on SIGHUP; tolerates a
# missing config (waits). Detached: own session, logs to /.atlas/mcp-hub/hub.log,
# never blocks init, dies with the container.
start_mcp_hub() {
  local bundle=/usr/local/lib/atlas/mcp-hub-server.mjs dir=/.atlas/mcp-hub
  if [ ! -f "$bundle" ]; then
    log "mcp-hub bundle missing ($bundle) — skipping hub"
    return 0
  fi
  mkdir -p "$dir" 2>/dev/null || true
  log "starting mcp-hub (background) → $dir/hub.log"
  ( setsid /usr/local/bin/node "$bundle" >"$dir/hub.log" 2>&1 & ) || true
}
start_mcp_hub || true

log "ready; awaiting exec turns"
exec sleep infinity
