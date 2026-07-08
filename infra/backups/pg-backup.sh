#!/usr/bin/env bash
# pg-backup.sh — Postgres backup for Atlas.
#
# Dumps the `app` schema from the production Postgres container, compresses it, and
# ships it offsite via rclone.
#
# Requirements:
#   - rclone installed and configured on the host (rclone config).
#   - TODO: set RCLONE_REMOTE below to your rclone remote + bucket path
#     (e.g. "ovh-swift:atlas-backups" for OVH Object Storage).
#   - /srv/atlas/.env holds POSTGRES_USER/POSTGRES_DB (the box's plaintext Postgres
#     store — same file docker compose reads for ${POSTGRES_*}; see infra/.env.compose.example).
#
# Retention:
#   - 7 daily backups (kept in daily/)
#   - 4 weekly backups (Sunday, kept in weekly/)
#
# Usage: run via crontab — see infra/backups/pg-backup.crontab.
# Manual run: sudo -u atlas /srv/atlas/scripts/pg-backup.sh
#
# Restore:
#   docker exec atlas-postgres pg_restore \
#       --schema=app --format=custom --clean --if-exists \
#       -U $POSTGRES_USER -d $POSTGRES_DB < /path/to/backup.dump

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────────
# Postgres creds come from /srv/atlas/.env (the box's plaintext store that docker
# compose also reads for ${POSTGRES_*}), NOT atlas.env — atlas.env is the backend's
# env_file and deliberately holds no POSTGRES_*. See infra/.env.compose.example.
COMPOSE_ENV="/srv/atlas/.env"
BACKUP_DIR="/srv/atlas/backups"
# TODO: replace with your actual rclone remote and bucket path.
RCLONE_REMOTE="ovh-swift:atlas-backups"  # TODO: configure rclone remote
CONTAINER="atlas-postgres"               # matches container_name in docker-compose.prod.yml

DAILY_KEEP=7
WEEKLY_KEEP=4

# ── Load postgres credentials ────────────────────────────────────────────────────
# shellcheck disable=SC1090
set -a; source "$COMPOSE_ENV"; set +a

POSTGRES_USER="${POSTGRES_USER:?POSTGRES_USER not set in $COMPOSE_ENV}"
POSTGRES_DB="${POSTGRES_DB:?POSTGRES_DB not set in $COMPOSE_ENV}"

# ── Filenames ────────────────────────────────────────────────────────────────────
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
WEEKDAY="$(date -u '+%u')"  # 1=Mon ... 7=Sun
FILENAME="atlas_${TIMESTAMP}.dump"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

BACKUP_PATH="$BACKUP_DIR/daily/$FILENAME"

# ── Dump ─────────────────────────────────────────────────────────────────────────
echo "[pg-backup] $(date -u) — Dumping schema=app from $CONTAINER ..."
docker exec "$CONTAINER" \
    pg_dump \
        --username="$POSTGRES_USER" \
        --schema=app \
        --format=custom \
        "$POSTGRES_DB" \
    > "$BACKUP_PATH"

echo "[pg-backup] Backup written to $BACKUP_PATH ($(du -sh "$BACKUP_PATH" | cut -f1))"

# ── Weekly copy (Sundays) ────────────────────────────────────────────────────────
if [[ "$WEEKDAY" == "7" ]]; then
    cp "$BACKUP_PATH" "$BACKUP_DIR/weekly/$FILENAME"
    echo "[pg-backup] Sunday — copied to weekly/"

    # Prune old weeklies
    ls -1t "$BACKUP_DIR/weekly/"*.dump 2>/dev/null \
        | tail -n +"$((WEEKLY_KEEP + 1))" \
        | xargs -r rm --
fi

# ── Prune old dailies ─────────────────────────────────────────────────────────────
ls -1t "$BACKUP_DIR/daily/"*.dump 2>/dev/null \
    | tail -n +"$((DAILY_KEEP + 1))" \
    | xargs -r rm --

# ── Offsite upload via rclone ────────────────────────────────────────────────────
echo "[pg-backup] Uploading to $RCLONE_REMOTE ..."
rclone copy "$BACKUP_DIR/daily/"  "$RCLONE_REMOTE/daily/"  --quiet
rclone copy "$BACKUP_DIR/weekly/" "$RCLONE_REMOTE/weekly/" --quiet

echo "[pg-backup] Done."
