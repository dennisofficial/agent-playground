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
#   - The sandbox image (atlas-sandbox:latest) auto-rebuilds on boot when its build
#     context (backend/sandbox/**) changed, via the image's context-hash label. To bust
#     Docker's own layer cache (e.g. re-pull a floating base/tool version), run
#     `docker rmi atlas-sandbox:latest` on the box before deploying.
#   - Idempotent: if the standby is already running (previous partial deploy), it is
#     recreated. If the state file is absent, blue is assumed active.

set -euo pipefail

SRV="/srv/atlas"
STATE_DIR="$SRV/state"
SECRETS_ENV="$SRV/secrets/atlas.env"
GHCR_OWNER="dennisofficial"
HEALTH_URL="https://api.atlas.dltechnologies.co/health/ready"
HEALTH_TIMEOUT=120   # seconds to wait for standby to become leader
POLL_INTERVAL=5      # seconds between health polls

# Sync the deploy-time infra files (this checkout — the workflow sparse-checks-out infra/, or a repo
# clone on the box) into the DURABLE $SRV so runtime never depends on the runner's ephemeral workspace,
# then run compose from there. Without this, the workflow runner invokes compose from
# /opt/actions-runner/_work/... — a DIFFERENT project name than a manual run from $SRV, which collides on
# the fixed `container_name: atlas-postgres` and finds no $SRV/.env for `${POSTGRES_*}` substitution.
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ "$SRC_DIR" != "$SRV" ]]; then
    cp "$SRC_DIR/docker-compose.prod.yml" "$SRV/docker-compose.prod.yml"
    cp "$SRC_DIR/Caddyfile" "$SRV/Caddyfile"
fi
COMPOSE_FILE="$SRV/docker-compose.prod.yml"

# All compose commands go through this: fixed project name `atlas` (stable regardless of cwd) + the
# durable env-file for `${POSTGRES_*}` substitution. `./Caddyfile` in the compose file resolves against
# the project directory ($SRV, the compose file's dir) → $SRV/Caddyfile.
DC() { docker compose -p atlas --env-file "$SRV/.env" -f "$COMPOSE_FILE" "$@"; }

# ── Parse arguments ─────────────────────────────────────────────────────────────
ROLLBACK=false
TAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rollback)
            ROLLBACK=true
            shift
            TAG="${1:?--rollback requires a tag argument}"
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
    echo "Usage: $0 <tag> | --rollback <tag>" >&2
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
    ATLAS_IMAGE_TAG="$restored_tag" DC up -d "backend-${restored_color}" || true
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

if [[ "$ROLLBACK" == "true" ]]; then
    log "=== ROLLBACK to $TAG ==="
    # Best-effort recovery path: warn (don't abort) on each wait so we always reach record_state and
    # leave the state files consistent with what we actually started.
    ATLAS_IMAGE_TAG="$TAG" DC pull "backend-${STANDBY}" || true
    ATLAS_IMAGE_TAG="$TAG" DC up -d "backend-${STANDBY}" || true
    wait_live "$STANDBY" 90 || log "WARN(rollback): backend-${STANDBY} did not report live"
    # Stop the active FIRST so it releases the advisory lock — the standby can only become leader
    # (pass /health/ready) once the active has let go of the lock.
    log "Stopping active backend-${ACTIVE} (graceful drain) ..."
    DC stop -t 300 "backend-${ACTIVE}" || true
    wait_ready "$STANDBY" "$HEALTH_TIMEOUT" || log "WARN(rollback): backend-${STANDBY} did not acquire leadership"
    wait_health "$HEALTH_URL" 30 "public health endpoint after rollback" || log "WARN(rollback): public endpoint not confirmed"
    record_state "$STANDBY" "$TAG"
    log "=== Rollback complete. Active: backend-${STANDBY} (${TAG}) ==="
    exit 0
fi

# ── 1. Pull new images ───────────────────────────────────────────────────────────
log "Pulling images for tag $TAG ..."
ATLAS_IMAGE_TAG="$TAG" DC pull \
    "backend-${STANDBY}" web

# ── 2. Run migrator (one-shot, on the atlas network) ────────────────────────────
# Ensure Postgres + Redis (and thus the `atlas` network) exist before the migrator joins it — on a
# fresh box `docker compose up` may never have run, so `docker run --network atlas` would fail.
# Idempotent: a no-op when they're already running.
log "Ensuring postgres + redis are up ..."
ATLAS_IMAGE_TAG="${PREV_TAG}" DC up -d postgres redis

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

# Export ATLAS_IMAGE_TAG for docker compose variable substitution.
export ATLAS_IMAGE_TAG="$TAG"

# ── 2.5. Ensure web + caddy are up ──────────────────────────────────────────────
# web + caddy are NOT part of the blue/green backend dance (they're stateless: caddy reverse-proxies
# whichever backend holds the leader lock, web is stateless SSR). `restart: unless-stopped` keeps them
# running, but on a fresh box they've never started — so bring them up here (idempotent). This lets a
# deploy COLD-BOOT the whole stack: without it, the public HEALTH_URL check below can't pass because
# caddy (TLS + proxy) isn't running. web is recreated on tag change; caddy's config is static.
log "Ensuring web + caddy are up (tag: ${TAG}) ..."
DC up -d web caddy

# ── 3. Start standby ────────────────────────────────────────────────────────────
log "Starting backend-${STANDBY} (tag: ${TAG}) ..."

DC up -d --no-deps \
    "backend-${STANDBY}" || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# Wait for the standby to be listening (/health/live = process is up, not yet leader).
wait_live "$STANDBY" 90 || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# ── 4. Drain and stop the active leader ─────────────────────────────────────────
# `docker compose stop -t 300` sends SIGTERM and waits up to 300s for the container
# to exit (stop_grace_period in compose also enforces this). The backend's
# BeforeApplicationShutdown hook:
#   1. Rejects new operator turns (503).
#   2. Awaits in-flight turns (up to the 120s drain-grace code constant).
#   3. Releases the advisory lock (or lets it auto-release on process exit).
# Once the old leader releases the lock, the standby acquires it and becomes leader.
log "Stopping backend-${ACTIVE} (sending SIGTERM, waiting up to 300s for drain) ..."
DC stop -t 300 "backend-${ACTIVE}" || true

# ── 5. Wait for standby to become leader (/health/ready) ────────────────────────
wait_ready "$STANDBY" "$HEALTH_TIMEOUT" || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# ── 6. Verify public health endpoint ────────────────────────────────────────────
log "Verifying public endpoint: $HEALTH_URL ..."
wait_health "$HEALTH_URL" 30 "public health endpoint" || rollback_and_exit "$STANDBY" "$ACTIVE" "$PREV_TAG"

# ── 7. Record new state ─────────────────────────────────────────────────────────
record_state "$STANDBY" "$TAG"

log "=== Deploy complete. Active: backend-${STANDBY} (${TAG}) ==="
log "Previous backend-${ACTIVE} is stopped. It will be the standby for the next deploy."
