#!/usr/bin/env bash
set -euo pipefail
# =============================================================================
# Fresh-slate reset for the dev/validation loop (pre-deploy; DESTROYS runtime data — not for production).
# Removes managed sandbox containers + their inner-docker volumes, and (optionally) the dev database. Run
# this before an end-to-end validation so a leaked volume or stale DB can't mask a regression.
#
#   bash backend/scripts/reset-sandboxes.sh                  # sandboxes + their volumes
#   RESET_DB=1 bash backend/scripts/reset-sandboxes.sh             # also drop/recreate the dev DB
# =============================================================================

log() { echo "[reset] $*"; }

log "removing managed sandbox containers…"
docker ps -aq --filter "label=com.agent.managed=1" | xargs -r docker rm -f

log "removing managed sandbox volumes…"
docker volume ls -q --filter "label=com.agent.managed=1" | xargs -r docker volume rm -f

if [ "${RESET_DB:-0}" = "1" ]; then
  PG_CONTAINER="${PG_CONTAINER:-atlas-postgres}"
  PG_USER="${POSTGRES_USER:-agent}"
  PG_DB="${POSTGRES_DB:-atlas}"
  log "dropping + recreating database ${PG_DB} in ${PG_CONTAINER} (harness must be stopped)…"
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE);" \
    -c "CREATE DATABASE ${PG_DB};"
fi

log "done."
