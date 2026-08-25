# Atlas v3 sandbox runtime

Each job runs in a **privileged, Docker-in-Docker pod** — a real dev box where the agent boots the repo
(`docker compose up` its DBs, start dev servers, run the app) to validate what it builds. Kubernetes is
authoritative (the Pod is the runtime, the mount is the durable identity); locally the cluster is **k3d**.

- `Dockerfile` — multi-stage image. Builder installs the pnpm workspace + webpacks the engine bundle
  **inside** the image; runtime is a slim glibc base with git + Docker CE + the baked engine + agent SDKs.
- `entrypoint.sh` — PID 1: start the inner dockerd (auto overlay2/vfs), then idle. Turns exec in.
- `atlas-classify` (baked in the Dockerfile, not a file here) — the reniced launcher Claude Code runs every
  Bash command through (via `CLAUDE_CODE_SHELL_PREFIX`, set on the engine in `launchEngineTurn`). Builds,
  installs and integration tests run at `nice 19` / idle IO so they never starve the engine's token stream;
  the engine itself keeps default priority. Node-level protection comes from the pod's CPU **request**
  (`POD_RESOURCES`), the floor the engine is guaranteed when many sandboxes saturate a node.
- `FINDINGS.md` — the S2a de-risking spike results (why privileged DinD + overlay2 + the resource envelope).

Operational scripts live in `backend/scripts/`, wired to pnpm. **k3d is a dev-only local emulation** —
in prod the runtime is k3s installed directly on the host, so these `dev-cluster:*` scripts have no prod
counterpart (only `sandbox:build`, which pushes to whatever registry the prod cluster pulls from, carries over):

- `pnpm dev-cluster:up` / `pnpm dev-cluster:down` — isolated `atlas` k3d cluster + `atlas-registry` lifecycle
  (`dev-cluster:up` injects `.env.local` so it uses the same `ATLAS_DATA` the host app does).
- `pnpm sandbox:build` — the deploy step: `docker build` (self-contained) → push to the local registry.

## Architecture decisions (carried from S2a)

- **Privileged DinD.** The pod runs `securityContext.privileged: true` with an in-pod `dockerd`. Security is
  an explicit non-goal for this personal project; hardening (a sysbox RuntimeClass) is deferred until/unless
  commercialized. No sysbox, no host-docker-socket.
- **`$ATLAS_DATA` = single storage root.** `$ATLAS_DATA/workspaces/<jobId>` → pod `/workspace` (DURABLE,
  survives reap — the repo worktree, kept **Atlas-agnostic**: no Atlas artifacts ever land here),
  `$ATLAS_DATA/state/<jobId>` → pod `/atlas` (Atlas-owned bookkeeping, e.g. the provisioned sentinel — kept
  OUT of the worktree), `$ATLAS_DATA/homes/<jobId>` (agent home — reserved, S3), `$ATLAS_DATA/cache`. On k3d
  it's bind-mounted into the node at cluster-create, so a pod `hostPath` mount is durable. Replaces per-job PVCs.
- **Registry + `imagePullPolicy: Always`** (same model dev + prod). Locally that's the k3d-managed registry;
  the image is built + pushed as a deploy step (alongside `db:migrate`).
- **overlay2 via a dedicated `/var/lib/docker`** emptyDir (keeps dockerd storage off the container root
  overlayfs so overlay2 initializes). Ephemeral; the durability that matters is on `/workspace`.
- **Resources:** requests cpu 250m / mem 512Mi, limits cpu 2 / mem 4Gi (proved sufficient incl. nested k3s).

## Environment

Shared-local values live in `backend/.env.local.enc` (encrypted, committed) and are typed in
`_core/config/env/validation.ts`. `pnpm dev-cluster:up` / `pnpm sandbox:build` inject them, so the scripts and
the host app read the same values.

| Var                      | Default (code)                                 | Notes                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `K8S_CONTEXT`            | _(unset → ambient current-context)_            | Pin the kubeconfig context. Set to `k3d-atlas` in `.env.local`. Boot fails loud if it isn't in your kubeconfig.                                                                                                                                                                                                         |
| `ATLAS_DATA`             | `/tmp/atlas-data`                              | Host storage root; **must match** what `dev-cluster:up` bind-mounts (set in `.env.local`).                                                                                                                                                                                                                              |
| `SANDBOX_IMAGE`          | `k3d-atlas-registry:5111/atlas-sandbox:latest` | In-cluster registry ref pods pull. Port is 5111 not 5000 (macOS AirPlay owns 5000); must match `ATLAS_REGISTRY_PORT` in `dev-cluster:up`. **Immutable per build** — `sandbox:build` writes the current `atlas-sandbox:<git-sha>` ref into `backend/.env.personal`, so this default only applies before the first build. |
| `SANDBOX_ENGINE_HOTSWAP` | `false`                                        | When `true`, pods mount the host-synced engine bundle (`$ATLAS_DATA/engine-bundle`) and run it instead of the baked one — so `engine:sync` updates the engine on the next turn with no pod restart. Off in prod (baked bundle wins).                                                                                    |

k3d bind-mount durability needs Docker Desktop file-sharing to cover `$ATLAS_DATA` (`/tmp` is shared by
default). For a home-dir root, set `ATLAS_DATA=$HOME/atlas-data` in `.env.local` and share it in Docker Desktop.

## Keeping running pods on the latest build

Engine code and runtime are delivered on **two different rates of change**, so they refresh two different ways.

**Engine code (changes constantly) — swappable, no restart.** The bundle is baked into the image as the default,
but each turn re-execs `atlas-engine-turn`, which prefers a host-synced bundle when present. With
`SANDBOX_ENGINE_HOTSWAP=true`, pods mount `$ATLAS_DATA/engine-bundle` at `/usr/local/lib/atlas/engine`; run
`pnpm engine:sync` (build + rsync) and the **next turn** runs the new engine — no docker build, no pod restart, so
the sandbox's running processes (inner dockerd, `docker compose` stacks, dev servers) **survive**. Because the
image ref is unchanged, the freshness gate below ignores it. (Prod hot-delivery of the bundle to nodes is a later
design item; prod runs the baked bundle and picks up engine changes via a normal image deploy.)

**Runtime / base image (rare — apt packages, base OS) — new image, pod recreate.** `pnpm sandbox:build` produces
an **immutable** `atlas-sandbox:<git-sha>` tag (a `-dirty-<ts>` suffix when the tree is dirty) and writes
`SANDBOX_IMAGE` into `backend/.env.personal`. On restart the host reads the new ref; `SandboxService.ensureReady`
compares each running pod's image to it at **turn start** and force-recreates on mismatch — so a running job picks
up the new image on its **next turn**, with no 30-min reap wait. Because this is gated at turn start (between
turns), it never interrupts a running turn. The reaper's 30-min idle TTL is unchanged (idle cleanup only).
Recreating drops inner-dockerd state, same as a reap cold-boot; the workspace and atlas-state hostPaths persist.

## Runbook (local)

All from `backend/` (pnpm scripts).

```bash
# 1. Bring up the isolated cluster + registry + $ATLAS_DATA bind-mount (ATLAS_DATA from .env.local)
pnpm dev-cluster:up

# 2. Build the image (engine bundle built inside) + push to the local registry
pnpm sandbox:build

# 3. (re)start the host app — it pins to $K8S_CONTEXT (k3d-atlas) and fails loud if that cluster is missing.
#    Create a job (POST /jobs) so the BullMQ provision step runs SandboxRuntime.ensureReady(jobId), then:
KX="kubectl --context k3d-atlas -n atlas-sandboxes exec sbx-<jobId> -c main --"
$KX ls /workspace                          # repo cloned here
$KX docker run --rm hello-world            # inner dockerd live
$KX sh -c 'cd /workspace && docker compose up -d'   # boot the repo's stack

# 4. Durability: delete the pod (or let the reaper take it), re-provision → /workspace still has the work.
# 5. Tear down (leaves $ATLAS_DATA intact)
pnpm dev-cluster:down
```

After provision succeeds, the flow advances to **dispatch**, which currently fails at the `TurnSpecBuilder`
stub — the expected end state until S3 builds a real `TurnSpec`.
