# Atlas — Production deployment guide

Single OVH box (~32 GB). Docker + docker-compose. Caddy for TLS termination.

---

## Directory layout on the box

```
/srv/atlas/
├── data/
│   ├── repos/          # per-org repo clones (REPOS_ROOT)
│   ├── agent-home/     # per-thread Claude/Codex config + session state (AGENT_HOME_ROOT)
│   ├── refs/           # read-only reference repo clones (REFS_ROOT)
│   ├── golden/         # operator golden-seed files (ATLAS_GOLDEN_ROOT)
│   └── engine/         # hot-reloaded engine bundle (ENGINE_BUNDLE_PATH parent)
│       └── engine-entrypoint.mjs   # written by bundleEngine() at boot
├── pgdata/             # Postgres data directory (bind-mounted into postgres container)
├── secrets/
│   └── atlas.env       # plaintext secrets — mode 600, never committed (see .env.prod.example)
├── caddy/
│   ├── data/           # Caddy certificate storage
│   └── config/         # Caddy runtime config
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

### 2. Create directory structure

```bash
sudo mkdir -p /srv/atlas/data/{repos,agent-home,refs,golden,engine}
sudo mkdir -p /srv/atlas/{pgdata,secrets,state,backups/{daily,weekly},scripts}
sudo mkdir -p /srv/atlas/caddy/{data,config}
sudo chown -R atlas:atlas /srv/atlas
sudo chmod 700 /srv/atlas/secrets
```

### 3. Drop secrets

Copy `infra/.env.prod.example` to `/srv/atlas/secrets/atlas.env`, fill in all
`CHANGEME` values, then:

```bash
sudo chmod 600 /srv/atlas/secrets/atlas.env
sudo chown atlas:atlas /srv/atlas/secrets/atlas.env
```

See the comments in `.env.prod.example` for each variable.

**Dotenvx note:** the encrypted `.env.*.enc` files committed in the repo are the
dotenvx-encrypted per-environment configs (see house style in `env-conventions`).
Their private keys (`DOTENV_PRIVATE_KEY_*`) are listed in `.env.prod.example` as
optional — they are only needed if you run backend CLI commands (migrations, seeds)
directly on the box outside of Docker.

### 4. DNS records

Add A (and optionally AAAA) records pointing at the box IP:

| Name | Type | Value |
|---|---|---|
| `api.atlas.dltechnologies.co` | A | `<box-ip>` |
| `atlas.dltechnologies.co` | A | `<box-ip>` |

Caddy handles TLS certificate provisioning via Let's Encrypt automatically once
DNS resolves. Email for LE notifications is set in `infra/Caddyfile`.

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

```bash
cd /path/to/atlas  # repo checkout on the box
docker compose -f infra/docker-compose.prod.yml up -d postgres redis
```

Wait for them to be healthy:
```bash
docker compose -f infra/docker-compose.prod.yml ps
```

### 7. Run initial migration

```bash
# TODO: replace <owner> and <tag> with the actual values.
docker run --rm \
    --network atlas \
    --env-file /srv/atlas/secrets/atlas.env \
    -e POSTGRES_HOST=postgres \
    -e POSTGRES_SSL_MODE=disable \
    -e NODE_ENV=production \
    ghcr.io/<owner>/atlas-backend-migrator:<tag>
```

> **Migrations must be backward-compatible (expand-contract).** `deploy.sh` runs the migrator BEFORE
> the blue/green swap, so during every deploy's drain window the **old** backend keeps serving in-flight
> turns against the **already-migrated** schema (and a rollback restores the old image but never
> down-migrates). A destructive change in a single deploy — dropping/renaming a column, adding a
> `NOT NULL`, tightening a type — will break the draining old code and make rollback unsafe. Ship such
> changes across **two deploys**: (1) additive migration + code that writes both old & new and reads
> new-with-fallback; (2) after it's live, the contracting migration that removes the old. Generate
> migrations the normal way (`pnpm db:migration:generate`, never hand-written — see the repo CLAUDE.md);
> the deploy applies them with `db:migrate:deploy`.

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
(`backend/src/app/sandbox/image/**`), the backend now **rebuilds the image automatically**
on boot: `ensureImage()` hashes the context files into an `atlas.context-hash` label and
rebuilds when it changes. `SANDBOX_REBUILD=1` is only needed to bust Docker's own layer
cache (e.g. re-pull a floating base/tool version):
```bash
SANDBOX_REBUILD=1 ./infra/deploy.sh sha-<gitsha>
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
# Copy backup file from offsite or local backup dir
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
a failed deploy, stop the old color manually: `docker compose -f infra/docker-compose.prod.yml stop backend-<old-color>`.

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
