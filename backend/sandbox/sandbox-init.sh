#!/usr/bin/env bash
# PID 1 of an Atlas v2 sandbox. Start the inner dockerd (DinD) so the agent can `docker compose up`
# its own Postgres / dev stack, then idle — engine turns are `docker exec`'d in by the host, one per
# turn. Requires the container to run --privileged with a volume at /var/lib/docker (so the inner
# overlay2 sits on a real fs, not overlay-on-overlay).
#
# This is the home for built-in, sandbox-lifetime Atlas infrastructure (each a detached `start_<svc>()`
# launched below, e.g. dockerd, the graphify watch, and the planned persistent mcp-hub) — contrast with
# `atlas-svc`, which is for the OPERATOR's own user-facing app processes only (dev server, app-under-test),
# started on demand by the agent, never from here.
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

# The Graphify STRUCTURAL index — an internal background daemon (NOT an atlas-svc user-facing service). It
# watches /workspace and MAINTAINS its AST knowledge graph on code changes (debounced), so the per-turn
# `graphify-mcp` reads a fresh graph.json even across a long, thousands-of-edits turn. NOTE: `graphify watch`
# only maintains — it does NOT build the INITIAL graph (with no changes it sits idle); the host kicks that
# first `graphify update` at provision (`kickCodeIndexRefresh`, which also seeds `.graphifyignore`). Keyless +
# local, so the watcher can start at container-create time (no per-exec secret) — unlike ccc, whose CLOUD
# embeddings need the per-org OpenAI key, so ccc is warm-built by the host and self-refreshes at query time
# (its MCP `search` re-indexes before searching). Writes to the PER-JOB index root under /.atlas.
start_graphify_watch() {
  local dir=/.atlas/code-index/graphify
  if ! command -v graphify >/dev/null 2>&1; then
    log "graphify not installed — skipping structural-index watcher"
    return 0
  fi
  mkdir -p "$dir" 2>/dev/null || true
  log "starting graphify watch on /workspace → $dir (background)"
  # GRAPHIFY_OUT redirects the graph OUT of the worktree — without it `graphify` writes graph.json into
  # /workspace/graphify-out (pollutes git AND isn't where graphify-mcp reads). With it, graph.json lands at
  # $GRAPHIFY_OUT/graph.json (= $dir/graph.json), matching the bridge's --graph path.
  # Detached: its own session, output to a log, never blocks init and dies with the container.
  ( cd "$dir" && GRAPHIFY_OUT="$dir" setsid graphify watch /workspace >"$dir/watch.log" 2>&1 & ) || true
}
start_graphify_watch || true

# The persistent MCP HUB — a built-in Atlas service (NOT atlas-svc). It connects ONCE per sandbox to all of
# the sandbox's user-defined MCP servers (stdio spawn / http+sse handshake), caches their tools, and serves
# each on a local loopback route the per-turn engine attaches to instantly (see image/mcp-hub-server.ts).
# This is what makes user MCP servers connect once per SANDBOX instead of once per TURN — killing both the
# per-turn re-spawn cost and the remote-connect race that left tools absent at turn-1. It reads its config
# (host-written union of the sandbox's servers) from /.atlas/mcp-hub.json on boot + on SIGHUP; tolerates a
# missing config (waits). Detached like the graphify watcher: own session, logs to /.atlas/mcp-hub/hub.log,
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
