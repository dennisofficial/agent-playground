#!/usr/bin/env bash
# =============================================================================
# Sandbox daemon ENTRYPOINT (Phase 10 — privileged DinD).
#
# The container runs `--privileged` with a per-sandbox `/var/lib/docker` volume (set by the host's
# ContainerManagerService). This script brings up the INNER Docker engine, waits until its socket is
# ready, then hands off (exec) to the Node daemon — so the agent's `docker compose up` is fully private
# to the sandbox (the collision fix the whole feature exists for).
#
# Lifecycle:
#   1) Start `dockerd` in the background (privileged; default unix socket /var/run/docker.sock).
#   2) Poll `docker info` until the inner daemon answers (or a bounded timeout → fail loudly).
#   3) `exec node dist/daemon/main.js` as PID 1's child, forwarding SIGTERM/SIGINT so a `docker stop`
#      cleanly shuts the Node daemon (its OnApplicationShutdown reaps process groups + downs inner
#      compose stacks), THEN stops dockerd.
#
# This is "correct-by-construction" — it is end-to-end VALIDATED only when the image is built and run
# `--privileged` with a /var/lib/docker volume and Redis reachable (not exercised in the unit gate).
# =============================================================================
set -euo pipefail

log() { echo "[entrypoint] $*"; }

DOCKERD_READY_TIMEOUT="${DOCKERD_READY_TIMEOUT:-120}"
DAEMON_ENTRY="${DAEMON_ENTRY:-/repo/backend/dist/daemon/main.js}"

dockerd_pid=""
daemon_pid=""

# Graceful shutdown: forward the term to the Node daemon FIRST (let it down inner stacks while dockerd
# is still up), wait for it, then stop dockerd. Idempotent — safe if a process already exited.
shutdown() {
  log "received shutdown signal — stopping daemon, then dockerd"
  if [ -n "${daemon_pid}" ] && kill -0 "${daemon_pid}" 2>/dev/null; then
    kill -TERM "${daemon_pid}" 2>/dev/null || true
    wait "${daemon_pid}" 2>/dev/null || true
  fi
  if [ -n "${dockerd_pid}" ] && kill -0 "${dockerd_pid}" 2>/dev/null; then
    kill -TERM "${dockerd_pid}" 2>/dev/null || true
    wait "${dockerd_pid}" 2>/dev/null || true
  fi
  log "shutdown complete"
  exit 0
}
trap shutdown SIGTERM SIGINT

# 1) Start the inner Docker engine. `--privileged` gives it the caps it needs; the per-sandbox volume
#    backs /var/lib/docker so images/containers are private + survive a daemon restart within the
#    sandbox's life. Logs go to a file so they don't drown the daemon's stdout (the host tails the
#    daemon's logs).
# Storage driver: default to dockerd's own auto-detect (overlay2 on a real Linux host = the OVH prod
# target — fast). But on Docker Desktop / any nested-overlay host, overlay2 cannot mount
# overlay-on-overlay (`failed to mount … overlay … invalid argument`) — set DOCKERD_STORAGE_DRIVER=vfs
# there (universally works, slower/more disk). The host's ContainerManager injects this per environment.
storage_opt=""
if [ -n "${DOCKERD_STORAGE_DRIVER:-}" ]; then
  storage_opt="--storage-driver=${DOCKERD_STORAGE_DRIVER}"
  log "inner dockerd storage-driver=${DOCKERD_STORAGE_DRIVER}"
fi

log "starting inner dockerd…"
# shellcheck disable=SC2086  # storage_opt is intentionally word-split (empty = no flag)
dockerd ${storage_opt} >/var/log/dockerd.log 2>&1 &
dockerd_pid=$!

# 2) Wait for the inner socket to answer. The Node daemon ALSO gates its readiness marker on docker
#    info (DaemonReadinessService) — this wait keeps the daemon from even starting until Docker is up,
#    so a turn never races a half-initialized engine.
log "waiting up to ${DOCKERD_READY_TIMEOUT}s for inner Docker…"
deadline=$(( $(date +%s) + DOCKERD_READY_TIMEOUT ))
until docker info >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    log "FATAL: inner dockerd did not become ready within ${DOCKERD_READY_TIMEOUT}s"
    cat /var/log/dockerd.log >&2 || true
    exit 1
  fi
  # If dockerd died, surface its log and fail rather than spin to the deadline.
  if ! kill -0 "${dockerd_pid}" 2>/dev/null; then
    log "FATAL: dockerd exited during startup"
    cat /var/log/dockerd.log >&2 || true
    exit 1
  fi
  sleep 1
done
log "inner Docker is ready"

# 3) Hand off to the Node daemon in the background so this script stays PID 1 and keeps trapping
#    signals (a plain `exec` would replace the trap-holding shell). Wait on it; on its exit, bring
#    dockerd down too.
log "starting daemon: ${DAEMON_ENTRY}"
node "${DAEMON_ENTRY}" &
daemon_pid=$!
wait "${daemon_pid}"
daemon_exit=$?
log "daemon exited (${daemon_exit}) — stopping dockerd"
if [ -n "${dockerd_pid}" ] && kill -0 "${dockerd_pid}" 2>/dev/null; then
  kill -TERM "${dockerd_pid}" 2>/dev/null || true
  wait "${dockerd_pid}" 2>/dev/null || true
fi
exit "${daemon_exit}"
