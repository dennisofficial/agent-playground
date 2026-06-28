#!/usr/bin/env bash
# deploy.sh — Blue/green deploy + migration + optional rollback.
#
# Usage:
#   ./infra/deploy.sh <tag>               Deploy image tag (e.g. sha-abc1234)
#   ./infra/deploy.sh --rollback <tag>    Roll back to a previously deployed tag
#
# State files (under /srv/atlas/state/):
#   active-color  — "blue" or "green" (which instance is currently the leader)
#   active-tag    — the image tag of the currently active instance
#
# Design notes:
#   - Drain-then-release: the old leader is stopped (SIGTERM → graceful drain → lock
#     release) before the standby is declared ready. See plan Part A3.
#   - The migrator runs as a one-shot container on the internal atlas network before
#     the standby is started, so schema changes land before any code that uses them.
#   - SANDBOX_REBUILD=1: pass this env var (or set it in the env) to force a rebuild
#     of the atlas-sandbox:latest image on first backend boot after a deploy that
#     changes backend/src/app/sandbox/image/**. The deploy.sh script accepts a flag
#     to set it automatically (see --rebuild-sandbox below).
#   - Idempotent: if the standby is already running (previous partial deploy), it is
#     recreated. If the state file is absent, blue is assumed active.
#
# TODO: replace <owner> with the actual GHCR owner.

set -euo pipefail

COMPOSE_FILE="$(dirname "$0")/docker-compose.prod.yml"
STATE_DIR="/srv/atlas/state"
SECRETS_ENV="/srv/atlas/secrets/atlas.env"
# TODO: replace <owner> with the actual GHCR owner.
GHCR_OWNER="<owner>"
HEALTH_URL="https://api.atlas.dltechnologies.co/health/ready"
HEALTH_TIMEOUT=120   # seconds to wait for standby to become leader
POLL_INTERVAL=5      # seconds between health polls

# ── Parse arguments ─────────────────────────────────────────────────────────────
ROLLBACK=false
SANDBOX_REBUILD="${SANDBOX_REBUILD:-}"  # set externally or via --rebuild-sandbox
TAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rollback)
            ROLLBACK=true
            shift
            TAG="${1:?--rollback requires a tag argument}"
            shift
            ;;
        --rebuild-sandbox)
            SANDBOX_REBUILD=1
            shift
            ;;
        -*)
            echo "Unknown flag: $1" >&2
            exit 1
            ;;
        *)
            TAG="$1"
            shift
            ;;
    esac
done

if [[ -z "$TAG" ]]; then
    echo "Usage: $0 <tag> | --rollback <tag> [--rebuild-sandbox]" >&2
    exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────────
log() { echo "[deploy] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

active_color() {
    if [[ -f "$STATE_DIR/active-color" ]]; then
        cat "$STATE_DIR/active-color"
    else
        echo "blue"  # default: assume blue is active on a fresh box
    fi
}

standby_color() {
    local active
    active="$(active_color)"
    if [[ "$active" == "blue" ]]; then echo "green"; else echo "blue"; fi
}

wait_health() {
    local url="$1" timeout="$2" desc="$3"
    local elapsed=0
    log "Waiting for $desc to be healthy at $url ..."
    while ! curl -sf "$url" >/dev/null 2>&1; do
        if [[ $elapsed -ge $timeout ]]; then
            log "ERROR: $desc did not become healthy within ${timeout}s" >&2
            return 1
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
    done
    log "$desc is healthy after ${elapsed}s."
}

wait_live() {
    local color="$1" timeout="${2:-60}"
    local url="http://localhost:4002/health/live"
    # Query via docker exec so we don't need port publishing.
    local container="atlas-backend-${color}"
    local elapsed=0
    log "Waiting for backend-${color} /health/live ..."
    while ! docker exec "$container" curl -sf http://localhost:4002/health/live >/dev/null 2>&1; do
        if [[ $elapsed -ge $timeout ]]; then
            log "ERROR: backend-${color} /health/live did not respond within ${timeout}s" >&2
            return 1
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
    done
    log "backend-${color} is live after ${elapsed}s."
}

wait_ready() {
    local color="$1" timeout="${2:-$HEALTH_TIMEOUT}"
    local container="atlas-backend-${color}"
    local elapsed=0
    log "Waiting for backend-${color} /health/ready (leader acquisition) ..."
    while ! docker exec "$container" curl -sf http://localhost:4002/health/ready >/dev/null 2>&1; do
        if [[ $elapsed -ge $timeout ]]; then
            log "ERROR: backend-${color} did not become leader within ${timeout}s" >&2
            return 1
        fi
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
    done
    log "backend-${color} is ready (leader) after ${elapsed}s."
}

record_state() {
    local color="$1" tag="$2"
    mkdir -p "$STATE_DIR"
    echo "$color" > "$STATE_DIR/active-color"
    echo "$tag"   > "$STATE_DIR/active-tag"
    log "State recorded: active=$color tag=$tag"
}

rollback_and_exit() {
    local failed_color="$1" restored_color="$2" restored_tag="$3"
    log "ERROR: deploy failed. Attempting rollback to $restored_color ($restored_tag) ..." >&2
    ATLAS_IMAGE_TAG="$restored_tag" docker compose -f "$COMPOSE_FILE" up -d "backend-${restored_color}" || true
    log "Rollback started. Monitor backend-${restored_color} manually." >&2
    exit 1
}

# ── Main ─────────────────────────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"

ACTIVE="$(active_color)"
STANDBY="$(standby_color)"
PREV_TAG="$(cat "$STATE_DIR/active-tag" 2>/dev/null || echo 'unknown')"

log "=== Atlas deploy ==="
log "Tag:     $TAG"
log "Active:  backend-${ACTIVE} (tag: ${PREV_TAG})"
log "Standby: backend-${STANDBY}"
[[ -n "$SANDBOX_REBUILD" ]] && log "SANDBOX_REBUILD=1 — the new backend will rebuild atlas-sandbox:latest on first boot."

if [[ "$ROLLBACK" == "true" ]]; then
    log "=== ROLLBACK to $TAG ==="
    # On rollback: start the standby at the old tag, stop the current active.
    ATLAS_IMAGE_TAG="$TAG" docker compose -f "$COMPOSE_FILE" pull "backend-${STANDBY}"
    ATLAS_IMAGE_TAG="$TAG" docker compose -f "$COMPOSE_FILE" up -d "backend-${STANDBY}"
    wait_live  "$STANDBY"
    wait_ready "$STANDBY"
    log "Stopping active backend-${ACTIVE} (graceful drain) ..."
    docker compose -f "$COMPOSE_FILE" stop -t 300 "backend-${ACTIVE}"
    wait_health "$HEALTH_URL" 30 "public health endpoint after rollback"
    record_state "$STANDBY" "$TAG"
    log "=== Rollback complete. Active: backend-${STANDBY} (${TAG}) ==="
    exit 0
fi

# ── 1. Pull new images ───────────────────────────────────────────────────────────
log "Pulling images for tag $TAG ..."
ATLAS_IMAGE_TAG="$TAG" docker compose -f "$COMPOSE_FILE" pull \
    "backend-${STANDBY}" web

# ── 2. Run migrator (one-shot, on the atlas network) ────────────────────────────
log "Running database migrations ..."
# Source the secrets env to get POSTGRES_* for the migrator container.
# shellcheck disable=SC1090
set -a; source "$SECRETS_ENV"; set +a

docker run --rm \
    --network atlas \
    --env-file "$SECRETS_ENV" \
    -e POSTGRES_HOST=postgres \
    -e POSTGRES_SSL_MODE=disable \
    -e NODE_ENV=production \
    "ghcr.io/${GHCR_OWNER}/atlas-backend-migrator:${TAG}"

log "Migrations complete."

# ── 3. Start standby ────────────────────────────────────────────────────────────
log "Starting backend-${STANDBY} (tag: ${TAG}) ..."

# Export ATLAS_IMAGE_TAG for docker compose variable substitution.
export ATLAS_IMAGE_TAG="$TAG"

# SANDBOX_REBUILD: if set, pass it as a container-level override via a temporary env
# file.  docker compose `up --env-file` injects into the compose file substitution
# context, not the container — so we use `docker run -e` style via a separate override.
# The cleanest approach: write a one-line override and use `docker compose run` --env,
# but `up` doesn't support per-service --env.  Instead we export SANDBOX_REBUILD into
# the shell environment; the x-backend-common anchor in docker-compose.prod.yml
# picks it up automatically because docker compose propagates exported shell vars that
# appear in the `environment:` map with no explicit value (implicit passthrough).
#
# docker-compose.prod.yml should include:
#   SANDBOX_REBUILD: "${SANDBOX_REBUILD:-}"
# in the x-backend-common environment block.  The parallel agent (Part A) adds this
# var to IEnvConfig; compose passes it through when the shell has it exported.

if [[ -n "$SANDBOX_REBUILD" ]]; then
    export SANDBOX_REBUILD=1
    log "SANDBOX_REBUILD=1 will be injected into backend-${STANDBY}."
fi

docker compose -f "$COMPOSE_FILE" up -d --no-deps \
    "backend-${STANDBY}" || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# Wait for the standby to be listening (/health/live = process is up, not yet leader).
wait_live "$STANDBY" 90 || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# ── 4. Drain and stop the active leader ─────────────────────────────────────────
# `docker compose stop -t 300` sends SIGTERM and waits up to 300s for the container
# to exit (stop_grace_period in compose also enforces this). The backend's
# BeforeApplicationShutdown hook:
#   1. Rejects new operator turns (503).
#   2. Awaits in-flight turns (up to DRAIN_GRACE_MS).
#   3. Releases the advisory lock (or lets it auto-release on process exit).
# Once the old leader releases the lock, the standby acquires it and becomes leader.
log "Stopping backend-${ACTIVE} (sending SIGTERM, waiting up to 300s for drain) ..."
docker compose -f "$COMPOSE_FILE" stop -t 300 "backend-${ACTIVE}" || true

# ── 5. Wait for standby to become leader (/health/ready) ────────────────────────
wait_ready "$STANDBY" "$HEALTH_TIMEOUT" || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# ── 6. Verify public health endpoint ────────────────────────────────────────────
log "Verifying public endpoint: $HEALTH_URL ..."
wait_health "$HEALTH_URL" 30 "public health endpoint" || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# ── 7. Record new state ─────────────────────────────────────────────────────────
record_state "$STANDBY" "$TAG"

log "=== Deploy complete. Active: backend-${STANDBY} (${TAG}) ==="
log "Previous backend-${ACTIVE} is stopped. It will be the standby for the next deploy."
