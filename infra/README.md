# Atlas — Production deployment guide

Single OVH box (64 GB, SYS-GAME-2). Docker + docker-compose. Caddy for TLS termination.

---

## Directory layout on the box

```
/srv/atlas/
├── data/
│   ├── repos/          # per-org repo clones (REPOS_ROOT)
│   ├── agent-home/     # per-thread Claude/Codex config + session state (AGENT_HOME_ROOT)
│   ├── refs/           # read-only reference repo clones (REFS_ROOT)
│   ├── skills/         # central skills store, per-org dirs bind-mounted rw at /skills (SKILLS_ROOT)
│   ├── golden/         # operator golden-seed files (ATLAS_GOLDEN_ROOT)
│   └── engine/         # hot-reloaded engine bundle (ENGINE_BUNDLE_PATH parent)
│       └── engine-entrypoint.mjs   # written by bundleEngine() at boot
├── pgdata/             # Postgres data directory (bind-mounted into postgres container)
├── .env                # compose interpolation store — POSTGRES_USER/PASSWORD/DB for ${..}
│                       # substitution + pg-backup.sh; mode 600 (see infra/.env.compose.example)
├── secrets/
│   ├── atlas.env       # plaintext secrets — mode 600, never committed (see .env.prod.example)
│   └── mcp-reader.env  # scoped MCP_READER_* only — mode 600 (see .env.mcp-reader.example)
├── caddy/
│   ├── data/           # Caddy certificate storage
│   ├── config/         # Caddy runtime config
│   └── admin/          # Caddy admin API unix socket (mounted into caddy + backend, same path)
├── state/
│   ├── active-color    # "blue" or "green" — the current leader
│   └── active-tag      # image tag of the current leader (e.g. sha-abc1234)
├── backups/
│   ├── daily/          # 7 daily pg_dump backups
│   └── weekly/         # 4 weekly pg_dump backups
└── scripts/            # operational scripts (pg-backup.sh, etc.)
```

Ownership: create as root, then `chown -R atlas:atlas /srv/atlas` (except pgdata
which Postgres manages itself). The `gha-runner` user needs write access to `state/`.

---

## First-box bootstrap

### 1. Prerequisites

```bash
# Install Docker CE
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Add your deploy user to the docker group (log out and back in after)
usermod -aG docker $USER
```

**Enlarge Docker's network address pool (required).** Atlas gives every job sandbox its own isolated
bridge network (`atlas-sbx-thread-<id>-net`). Docker's built-in default pool only yields ~31 subnets, so a
busy box exhausts it and sandbox creation fails with:

> (HTTP code 400) unexpected - all predefined address pools have been fully subnetted

Install the repo's `infra/daemon.json` (base `10.100.0.0/14`, /24 subnets → 1024 networks) before starting
Atlas. This restarts the daemon, so do it now (nothing else is running yet) or during a maintenance window:

```bash
# Merge into an existing /etc/docker/daemon.json if one is already present (don't blindly overwrite).
sudo cp infra/daemon.json /etc/docker/daemon.json
sudo systemctl restart docker                              # restarts ALL containers
docker system info | grep -A4 'Default Address Pools'      # verify: 10.100.0.0/14, size 24
```

The range must not collide with any subnet the box already uses on its host/LAN/VPN — check first
(`ip -o addr` / `ip route`). `10.100.0.0/14` was chosen for the OVH prod box because Docker's built-in
default already scattered networks across `172.16/12` + `192.168/16` there (so a 172.x pool collided) and
`10.x` was entirely free. On a box where `10.100–10.103.x.x` is in use, pick another free RFC1918 range.

**Emergency reclaim (if the pool is already exhausted on a running box):** leaked, unused sandbox networks
can be dropped without a daemon restart — `prune` only removes networks with no attached container:

```bash
docker network prune -f
docker network ls | grep atlas-sbx        # confirm the leaked -net's are gone
```

The backend now also sweeps leaked `atlas-sbx-*-net` networks automatically (leader-gated reap timer + once
on leadership acquisition), so this manual reclaim is only for pre-fix boxes or a one-off wedge.

### 2. Create directory structure

```bash
sudo mkdir -p /srv/atlas/data/{repos,agent-home,refs,golden,engine}
sudo mkdir -p /srv/atlas/{pgdata,secrets,state,backups/{daily,weekly},scripts}
sudo mkdir -p /srv/atlas/caddy/{data,config,admin}
sudo chown -R atlas:atlas /srv/atlas
sudo chmod 700 /srv/atlas/secrets
```

### 3. Drop secrets

`backend/.env.production.enc` is committed, dotenvx-encrypted ciphertext (see house
style in `env-conventions`) — safe in git, and baked straight into the backend/migrator
images by `infra/backend.Dockerfile`. The box itself only needs to hold the one thing
that lets those images decrypt it: the production private key.

Copy `infra/.env.prod.example` to `/srv/atlas/secrets/atlas.env`, fill in
`DOTENV_PRIVATE_KEY_PRODUCTION_ENC` (from `backend/.env.keys` — never commit that
file), then:

```bash
sudo chmod 600 /srv/atlas/secrets/atlas.env
sudo chown atlas:atlas /srv/atlas/secrets/atlas.env
```

`backend-entrypoint.sh` decrypts `.env.production.enc` at container start given that
key (`dotenvx run -f .env.production.enc -- node dist/main`); the migrator image does
the same before running migrations. So `atlas.env` holds only the private key + infra
wiring — **no `POSTGRES_*`** (see the guard note in `.env.prod.example`).

Compose provisions the `postgres` container at parse time — before any container, let
alone dotenvx, runs — so it needs `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` as
plain values. These live in a separate box file, `/srv/atlas/.env`, which `deploy.sh`
passes to every compose command via `--env-file` (and which `pg-backup.sh` sources):

```bash
cp infra/.env.compose.example /srv/atlas/.env
# fill in POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB — MUST match the encrypted copy
sudo chmod 600 /srv/atlas/.env
sudo chown atlas:atlas /srv/atlas/.env
```

> **Env domains — the three-way split (there is no duplicate env *file*).**
> - **infra** — `/srv/atlas/secrets/atlas.env` (the dotenvx private key + host/port/data-root wiring; the backend's compose `env_file:`) and `/srv/atlas/.env` (Postgres bootstrap for `${POSTGRES_*}` compose interpolation + backups).
> - **backend** — `backend/.env.production.enc` (committed ciphertext, decrypted in-container at startup; the **authoritative** source for app secrets incl. the real `POSTGRES_*`).
> - **frontend** — `NEXT_PUBLIC_*`, baked into the bundle at `next build` time (nothing at runtime).
>
> The only value that must be maintained in two places is the 3 Postgres vars — plain in `/srv/atlas/.env` (compose can't read the `.enc` when it creates the DB container) and encrypted in `backend/.env.production.enc`. Keep them in sync. They are deliberately kept out of `atlas.env` so they don't shadow the enc-decrypted values in the backend container.

To add/rotate a secret: edit `backend/.env.production.enc` locally with
`pnpm exec dotenvx set KEY value -f .env.production.enc` (see `env-conventions` for
the "seed the key manually first" rule on brand-new vars), commit, push — the next
CI build bakes the new ciphertext in. No box-side secret file changes needed unless
the private key itself rotates.

### 4. DNS records

Add A (and optionally AAAA) records pointing at the box IP:

| Name | Type | Value |
|---|---|---|
| `api.atlas.dltechnologies.co` | A | `<box-ip>` |
| `atlas.dltechnologies.co` | A | `<box-ip>` |
| `*.atlas.dltechnologies.co` | A | `<box-ip>` |

Caddy handles TLS certificate provisioning via Let's Encrypt automatically once
DNS resolves. Email for LE notifications is set in `infra/Caddyfile`.

The `*.atlas.dltechnologies.co` wildcard record covers every ephemeral sandbox-preview
subdomain (`<previewId>-<svc>.atlas.dltechnologies.co`). Its wildcard TLS cert can't use
HTTP-01/TLS-ALPN (a CA policy for wildcards), so Caddy issues it via the ACME **DNS-01**
challenge using the `caddy-dns/cloudflare` module (baked into `infra/caddy.Dockerfile`).
That needs a scoped Cloudflare API **token** (not the global key) with **Zone:Read +
DNS:Edit** on the `dltechnologies.co` zone, set as `CLOUDFLARE_API_TOKEN` in
`/srv/atlas/secrets/atlas.env` (see `infra/.env.prod.example`). The one wildcard cert is
reused by every preview route the backend adds dynamically — no per-subdomain issuance.

### 5. Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

### 6. Start Postgres and Redis first

Every manual `docker compose` command must pass `--env-file /srv/atlas/.env` so
`${POSTGRES_*}` resolves (deploy.sh does this automatically; a bare `docker compose`
leaves them unset and postgres comes up with wrong/empty credentials):

```bash
cd /path/to/atlas  # repo checkout on the box
docker compose --env-file /srv/atlas/.env -f infra/docker-compose.prod.yml up -d postgres redis
```

Wait for them to be healthy:
```bash
docker compose --env-file /srv/atlas/.env -f infra/docker-compose.prod.yml ps
```

### 7. Run initial migration

```bash
docker run --rm \
    --network atlas \
    --env-file /srv/atlas/secrets/atlas.env \
    -e POSTGRES_HOST=postgres \
    -e POSTGRES_SSL_MODE=disable \
    -e NODE_ENV=production \
    ghcr.io/dennisofficial/atlas-backend-migrator:<tag>
```

Replace `<tag>` with the `sha-<gitsha>` tag `ci.yml` published for the commit you're deploying (see the GitHub Actions run summary, or `git rev-parse --short HEAD` for the current `main` tip once CI has built it).

> **Migrations must be backward-compatible (expand-contract).** `deploy.sh` runs the migrator BEFORE
> the blue/green swap, so during every deploy's drain window the **old** backend keeps serving in-flight
> turns against the **already-migrated** schema (and a rollback restores the old image but never
> down-migrates). A destructive change in a single deploy — dropping/renaming a column, adding a
> `NOT NULL`, tightening a type — will break the draining old code and make rollback unsafe. Ship such
> changes across **two deploys**: (1) additive migration + code that writes both old & new and reads
> new-with-fallback; (2) after it's live, the contracting migration that removes the old. Generate
> migrations the normal way (`pnpm db:migration:generate`, never hand-written — see the repo CLAUDE.md);
> the deploy applies them with `db:migrate:deploy`.

### 7.5. Create the read-only MCP-reader role

The `mcp-reader` service (standalone, read-only prod-diagnostics MCP server) connects with a dedicated
**SELECT-only** Postgres role — this is what makes its production access read-only *structurally* (it
physically cannot INSERT/UPDATE/DELETE or run DDL), not just by convention. Create it once, after the
schema exists (step 7), with the idempotent `infra/mcp-reader-role.sql`:

```bash
# Set MCP_READER_API_KEY + MCP_READER_PG_PASSWORD + MCP_READER_PG_DB in /srv/atlas/secrets/mcp-reader.env
# first — the reader's OWN scoped secret file (template: infra/.env.mcp-reader.example), NOT atlas.env, so
# the untrusted-data-ingesting reader never sees the backend's full secret bundle. Create it once:
#   cp infra/.env.mcp-reader.example /srv/atlas/secrets/mcp-reader.env  # then fill in + chmod 600
# MCP_READER_PG_USER stays `mcp_reader`; MCP_READER_PG_DB == POSTGRES_DB.
set -a; source /srv/atlas/.env; set +a   # POSTGRES_USER / POSTGRES_DB
PW="$(grep -E '^MCP_READER_PG_PASSWORD=' /srv/atlas/secrets/mcp-reader.env | cut -d= -f2-)"
docker exec -i atlas-postgres psql -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v mcp_reader_password="$PW" \
    -f - < infra/mcp-reader-role.sql
```

The script is re-runnable — running it again refreshes the grants and resets the password (so it doubles
as the DB-credential rotation step). The `mcp-reader` service (step 8) picks up the role via the
`MCP_READER_PG_*` secrets.

**Register the server for the Atlas repo (operator, one-time, in the web UI).** The reader has **no public
port and no Caddy route** — it's reachable only from Atlas-repo sandboxes over the internal `atlas-mcp`
network. In the web console's MCP settings, for the **Atlas repo only**, add a server:

- Transport: **Streamable HTTP**
- URL: `http://mcp-reader:4100/` (internal Docker DNS — resolvable because Atlas-repo sandboxes are
  attached to `atlas-mcp`; gated on `ATLAS_REPO_SLUG` matching the repo's slug)
- Header: `X-Api-Key: <MCP_READER_API_KEY>` (the same value stored in `mcp-reader.env`)

Only Atlas-repo jobs then receive both the network route **and** the key. Rotating the key = change
`MCP_READER_API_KEY` in `mcp-reader.env`, re-save the web-registry value, then `docker compose … up -d
mcp-reader`.

### 8. Start all services

```bash
export ATLAS_IMAGE_TAG=<tag>  # the initial image tag to deploy
docker compose -f infra/docker-compose.prod.yml up -d
```

On first backend boot (backend-blue starts first), the process:
1. Calls `bundleEngine()` → writes `engine-entrypoint.mjs` to the fixed
   `backend/sandbox/` build-context dir AND to `ENGINE_BUNDLE_PATH`.
2. Calls `SandboxImageBuilder.ensureImage()` → builds `atlas-sandbox:latest` on the
   host Docker daemon. **This takes several minutes on first boot** — it installs
   Docker CE inside the image and pulls Node.js layers.

Watch the build:
```bash
docker logs -f atlas-backend-blue
```

### 9. Smoke test

```bash
# Health endpoints
curl https://api.atlas.dltechnologies.co/health/live
curl https://api.atlas.dltechnologies.co/health/ready

# Open the web console
open https://atlas.dltechnologies.co
```

Create a thread and verify a sandbox spawns (watch `docker ps` for a new container).

---

## Deploying updates

The CI/CD pipeline (`deploy.yml`) deploys automatically on every push to `main`
after the `ci.yml` build succeeds and the GitHub Environment reviewer approves.

Manual deploy:
```bash
./infra/deploy.sh sha-<gitsha>
```

Rollback:
```bash
./infra/deploy.sh --rollback sha-<previous-tag>
```

When you change the sandbox image context (`backend/sandbox/**`) or the engine sources
(`backend/src/app/sandbox/image/**`), the backend **rebuilds the image automatically**
on boot: `ensureImage()` hashes the context files into an `atlas.context-hash` label and
rebuilds when it changes. To bust Docker's own layer cache (e.g. re-pull a floating
base/tool version), remove the image on the box before deploying:
```bash
docker rmi atlas-sandbox:latest && ./infra/deploy.sh sha-<gitsha>
```

---

## Backups

Install the backup cron:
```bash
sudo cp infra/backups/pg-backup.sh /srv/atlas/scripts/pg-backup.sh
sudo chmod +x /srv/atlas/scripts/pg-backup.sh
sudo crontab -u atlas /dev/stdin <<'EOF'
0 2 * * * /srv/atlas/scripts/pg-backup.sh >> /var/log/atlas-backup.log 2>&1
EOF
```

Configure rclone for offsite upload (OVH Object Storage or similar):
```bash
rclone config  # follow prompts to add the remote
# Update RCLONE_REMOTE in pg-backup.sh to match your remote name + bucket
```

### Restore

```bash
# Copy backup file from offsite or local backup dir, then load the Postgres creds:
set -a; source /srv/atlas/.env; set +a
docker exec -i atlas-postgres pg_restore \
    --schema=app --format=custom --clean --if-exists \
    -U $POSTGRES_USER -d $POSTGRES_DB \
    < /srv/atlas/backups/daily/atlas_<timestamp>.dump
```

---

## GitHub Actions runner

See `infra/runner/README.md` for setup and security notes.

---

## Troubleshooting

**Caddy can't get TLS cert:** DNS not propagated yet, or port 80/443 blocked by
firewall. Check `docker logs atlas-caddy` and `ufw status`.

**Backend stuck on /health/ready (follower):** another instance holds the advisory
lock. Check `docker ps` — only one backend should be running. If both are up after
a failed deploy, stop the old color manually: `docker compose --env-file /srv/atlas/.env -f infra/docker-compose.prod.yml stop backend-<old-color>`.

**Sandbox build fails on first boot:** `docker logs atlas-backend-blue | grep -i sandbox`.
Common causes: docker socket permission (check `ls -la /var/run/docker.sock`), or
`ENGINE_BUNDLE_PATH` parent dir not created.

**Migration fails:** check that Postgres is healthy and the migrator can reach it
on the `atlas` network. Run the migrator manually (step 7) with extra debug output:
```bash
docker run --rm --network atlas --env-file /srv/atlas/secrets/atlas.env \
    -e POSTGRES_HOST=postgres -e POSTGRES_SSL_MODE=disable \
    -e NODE_ENV=production -e DEBUG=typeorm \
    ghcr.io/<owner>/atlas-backend-migrator:<tag>
```
