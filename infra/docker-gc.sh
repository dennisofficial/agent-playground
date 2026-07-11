#!/usr/bin/env bash
# docker-gc.sh — reclaim Docker disk on the Atlas box.
#
# Three leaks accumulate under /var/lib/containerd (Docker's containerd image store):
#   1. Old `sha-<gitsha>` DEPLOY images. Every deploy pulls a fresh backend (~2.7G),
#      backend-migrator (~3.5G) and web (~0.4G); the previous tags are never removed.
#   2. Orphaned SANDBOX images. `atlas-sandbox:latest` is rebuilt in place when its
#      build context changes (SandboxImageBuilder.ensureImage); the old image is left
#      untagged as `<none>` (~4.9G each).
#   3. Build cache from those sandbox-image rebuilds.
#
# This reaps all three. It is SAFE to run anytime (including on a timer) and never
# interferes with running workloads:
#   - It removes deploy tags with `docker rmi` *without* `-f`. Docker refuses to delete
#     an image referenced by an existing container, so the ACTIVE backend and any
#     stopped-standby / rollback image survive automatically — they are simply skipped.
#   - Dangling-image + build-cache prune only touch untagged, unreferenced content.
#   - It NEVER removes containers, networks or volumes.
#
# Usage:  ./docker-gc.sh              # reap, keeping the newest $KEEP deploy tags per repo
#         ATLAS_GC_KEEP=3 ./docker-gc.sh
#
# Env:
#   GHCR_OWNER      GHCR namespace for the deploy images (default: dennisofficial)
#   ATLAS_GC_KEEP   newest sha-* tags to keep per repo, for rollback headroom (default: 5)

set -uo pipefail

GHCR_OWNER="${GHCR_OWNER:-dennisofficial}"
KEEP="${ATLAS_GC_KEEP:-5}"
REPOS=(atlas-backend atlas-backend-migrator atlas-web)

log() { echo "[docker-gc] $(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

before="$(df -B1 --output=used / | tail -1 | tr -d ' ')"
log "starting — $(df -h --output=pcent / | tail -1 | tr -d ' ') used on /, keeping newest $KEEP tags/repo"

# ── 1. Trim old sha-* deploy image tags, keeping the newest $KEEP per repo ──────────
# Sort by the image's RFC3339 Created time (lexical sort == chronological) so "newest"
# is unambiguous regardless of the git sha. `docker rmi <ref>` (no -f) untags; the
# backing layers drop once no tag/container references them.
for repo in "${REPOS[@]}"; do
    img="ghcr.io/${GHCR_OWNER}/${repo}"
    # Build "<createdRFC3339>\t<repo:tag>" lines for every tag of this repo.
    mapfile -t refs < <(
        docker images "$img" --format '{{.ID}} {{.Repository}}:{{.Tag}}' 2>/dev/null \
            | while read -r id ref; do
                [[ "$ref" == *:'<none>'* ]] && continue
                created="$(docker inspect -f '{{.Created}}' "$id" 2>/dev/null)" || continue
                printf '%s\t%s\n' "$created" "$ref"
            done | sort -r | tail -n +"$((KEEP + 1))" | cut -f2-
    )
    for ref in "${refs[@]}"; do
        if docker rmi "$ref" >/dev/null 2>&1; then
            log "removed old deploy image $ref"
        else
            log "kept (in use) $ref"
        fi
    done
done

# ── 2. Prune dangling images (orphaned atlas-sandbox:latest rebuilds, etc.) ─────────
# Only untagged images with no container reference are removed — a live sandbox pins
# its own image, so this reaps exactly the rebuilt-away orphans.
reclaimed_img="$(docker image prune -f 2>/dev/null | awk -F': ' '/Total reclaimed space/{print $2}')"
log "dangling images pruned (${reclaimed_img:-0})"

# ── 3. Prune build cache older than 7 days ─────────────────────────────────────────
reclaimed_bc="$(docker builder prune -f --filter 'until=168h' 2>/dev/null | awk '/Total:/{print $2}')"
log "build cache pruned >168h (${reclaimed_bc:-0})"

after="$(df -B1 --output=used / | tail -1 | tr -d ' ')"
freed=$(( (before - after) / 1024 / 1024 / 1024 ))
log "done — freed ~${freed}G; now $(df -h --output=pcent / | tail -1 | tr -d ' ') used on /"
