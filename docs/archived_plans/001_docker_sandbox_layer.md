# Atlas v2 — Docker sandbox layer (network-isolated, multi-tenant, DinD)

## Context

Atlas v2 (`backend/src/atlas/`) is built and proven live, but execution is **host-only**: a per-feature "sandbox" is just a local git worktree (`git/local-git.service.ts`), and engine turns run **in-process on the host** (`engine/engine-runner.service.ts` iterates the Claude/Codex SDK against a `cwd`). This was the deliberate deferral in the original plan (`docs/archived_plans/000_atlas_v2_a_legible_orchestrator.md`). This plan does the deferred piece: a real Docker sandbox layer.

**v1 is already gone.** During this session W8 was executed and committed — `f82a748 "Remove v1 harness system — atlas v2 is the sole orchestrator"` on `main`; `backend/src/harness/**` no longer exists. So the clean-room "zero v1 imports" rule is now automatic (nothing to import), and this plan is written **self-contained** — it does not depend on v1 source for reference. The only v1 residue to clean up is **orphaned env vars** in `_core/config/env/validation.ts` (`WORKSPACE_*`, `DOCKER_SOCKET_PATH`, `REFS_ROOT` — the code that read them is deleted); we adopt the still-relevant ones and prune the dead daemon/Redis ones. (Stale-doc note: `ATLAS_V2.md §6` says "W8 held" and `§8` says Docker "routes turn-execution + git into the container" — both predate this session's decisions and will be corrected on implement; see the git decision below.)

**Why Docker (locked by Dennis this session):** the value is **network-isolated full environments**, not "jail the agent's bash." Each sandbox is a live environment that can run a dev server + its own Postgres (inner Docker) and test the feature it's building; one sandbox can run feature-A's stack, another feature-B's, a third a host instance Dennis pokes at himself — without polluting the host or each other. The host is **multi-tenant** (Dennis, his mom, his brother).

We keep the *capabilities* v1 had (privileged DinD, per-feature containers, a `/refs` reference library) and throw away its *transport*: v1's fragility was a long-lived in-container NestJS daemon over **Redis RPC** with version-reconcile + readiness races. Here the sandbox is a dumb long-lived jail and the host drives it with **one-shot `docker exec` per turn** — no in-container app, no Redis, no version reconcile.

## Locked decisions (this session)

- **Isolation via container + per-sandbox Docker network.** Network separation between sandboxes is the point; checkout location is orthogonal to it.
- **DinD = privileged + inner `dockerd` per sandbox.** Tenants are family on a non-commercial host, so privileged escape risk is accepted for the simplest DinD that works everywhere (incl. macOS dev). No sysbox/gVisor.
- **Transport = one-shot `docker exec` per turn.** Sandbox is long-lived (holds checkout, inner dockerd, running dev servers); each engine turn is an ephemeral exec streaming NDJSON back. Concurrency = N independent host-side drives under a semaphore — the explicit answer to "how do many agents run at once": no shared bus, just N subprocesses + a cap.
- **Checkout = bind-mounted host worktree; git + PR stay host-side.** (See "Resolved: git stays host-side" — supersedes `ATLAS_V2.md §8`.)
- **Dev-server exposure = reverse-proxy-by-hostname — documented as an immediate follow-up, NOT built here.** This pass lays groundwork (per-sandbox network, discovery labels) and records the design; the proxy is the next plan.

## The model

**A sandbox is a long-lived, privileged, network-isolated container, one per in-flight feature** (keyed `team · project · branch` — same unit as today's worktree). PID 1 is a tiny init that starts inner `dockerd` and idles. It bind-mounts the host feature worktree at `/work`, the per-feature engine agent-home, and a read-only `/refs`. The agent never runs as PID 1 — each turn is `docker exec`'d in and exits. Dev servers / inner Postgres the agent starts **persist between turns** as long as the sandbox lives (this is what makes "a sandbox Dennis can test himself" fall out for free).

**Resolved: git stays host-side (supersedes `ATLAS_V2.md §8`).** Network isolation comes from the container/network, not from where files live, so we keep the legible host-side git substrate: `LocalGitService` commits the bind-mounted worktree from the host after each phase, and `GithubPrService` opens the PR over the GitHub API — **both untouched**. Only *execution* moves into the container. This is a deliberate **security plus**: the GitHub push/fetch token never enters the (untrusted-agent) sandbox, so it can't be exfiltrated, and git network egress stays host-side. Consequence: the agent inside cannot do *authenticated network git* (it can run local git against `/work`; host mediates fetch/push). Authenticated private git submodules are the one edge case — deferred/noted; `/refs` covers cross-repo reads. **Uid handling:** the container runs `dockerd` as root but the engine is `docker exec --user <host-uid>`, and that uid is added to the in-container `docker` group — so `/work` files stay host-owned (no root-owned-file friction for host-side git) *and* the agent can still drive inner Docker. (Fallback if bind-mount uid/perf friction bites: clone-in-container with git over the same exec transport — strictly more code, not chosen.)

## What changes — two DI ports; the brain/driver/gate/PR logic is identical

The brain, decision-gate, section/phase driver flow, auto-fix logic, persistence, and PR flow **do not change**. We introduce two ports and bind a `docker` implementation behind `ATLAS_SANDBOX_MODE=local|docker` (default `local`; `local` is byte-identical to today):

1. **`ENGINE_RUNNER`** (new token; today's `EngineRunner` becomes the `local` binding). The `docker` binding `DockerEngineRunner` serializes the turn spec and `docker exec`s the **engine entrypoint** inside the target container.
2. **`SANDBOX_PROVIDER`** (new token). `local` = worktree only (today's `git.createFeatureSandbox`); `docker` = worktree **+** ensure the container. `FeatureSandbox` gains an optional `containerId`.

**Explicit execution target (fixes "runner can't tell which container").** Today `RunEngineArgs` carries only `cwd` + `sandboxKey` (`engine/engine.types.ts`), and `TurnRunnerService` strips `FeatureSandbox` to those. We add an explicit `target?: { containerId: string; user?: string }` to `RunEngineArgs`. The `local` runner ignores it; `DockerEngineRunner` requires it. Nothing is derived from a string — the container id is passed through the port.

**Every live execution path must route through `ENGINE_RUNNER` and carry the target — there are three, not one:**
- **(a) Driver plan/phase turns** — via `runner/turn-runner.service.ts`. It injects `ENGINE_RUNNER`, and populates `target` from `sandbox.containerId`.
- **(b) Auto-fix review + fix turns** — `autofix/autofix.stage.ts` calls `EngineRunner` **directly** (not via TurnRunner). It must inject `ENGINE_RUNNER`, and `AutoFixContext` must gain `containerId` (the driver already holds the `sandbox` when it calls `autofixSection`/`autofixPullRequest` in `section-driver.service.ts` — thread it through). Each parallel review lens = a concurrent `exec` into the same container with its own home sub-key.
- **(c) Acceptance gate** — `gate/acceptance-gate.service.ts` (the `atlas:gate` live proof) creates a worktree and calls `EngineRunner` **directly**. Wire it through the same `ENGINE_RUNNER` + `SANDBOX_PROVIDER` so `atlas:gate --live` runs in docker mode — it then doubles as the smallest live smoke test of the substrate (D1/D2 gate).

## Architecture / new components (`backend/src/atlas/sandbox/`)

- **`container-engine.port.ts` + `dockerode-container-engine.ts`** (`CONTAINER_ENGINE` token) — the one narrow Docker seam, on `dockerode` (already a dep: `package.json` `dockerode ^4.0.1` + `@types/dockerode`). Methods (from first principles, no v1 dependency): `ensureNetwork(name)`, `ensureImage()`, `createContainer({image, name, network, binds, labels, privileged, dindVolume, env})`, `start(id)`, **`exec(id, argv, {user, env, stdin, onStdout})` (streamed — the workhorse)**, `stop(id)`, `remove(id)`, `list({label})`, `inspect(id)`.
- **`sandbox-image.builder.ts`** — boot-memoized base-image build (build via dockerode, skip if present unless `ATLAS_SANDBOX_REBUILD`). Dockerfile + entrypoint under `sandbox/image/`. Image: node + pnpm + git + the `claude` & `codex` CLIs + the `docker` CLI + `dockerd` + the bundled engine entrypoint. Single shared base image for v1; per-project images deferred.
- **Engine entrypoint** (`sandbox/image/engine-entrypoint.ts`, bundled into the image) — reads one turn spec as JSON on stdin, runs **the same EngineRunner vendor core** and emits NDJSON, ending with `{result, sessionId, planText, usage}`. To avoid divergence, extract `engine/engine-runner.service.ts`'s vendor logic (canUseTool / plan-capture / write-boundary / Claude+Codex drivers) into a **shared module** imported by both the in-process `EngineRunner` and the entrypoint. Session resume works because `CLAUDE_CONFIG_DIR`/`CODEX_HOME` live in the per-feature agent-home that persists across execs.
- **`docker-engine-runner.ts`** (`ENGINE_RUNNER` = `docker`) — host side: marshal `RunEngineArgs` (minus callbacks), `exec` the entrypoint with creds passed as **exec env** (never baked into image/labels), parse NDJSON → re-emit `onEvent` → return `EngineRunResult`. Abort = kill the exec stream.
- **`sandbox-manager.service.ts`** (`SANDBOX_PROVIDER` = `docker`) — lifecycle: `acquire(job, repo, worktree)` ensures the container (idempotent; resume reuses), `teardown` on done/fail. Inner-dockerd **readiness poll** (`docker info` via exec) before the first build turn. **Boot adoption by label** (re-attach in-flight jobs' containers, reap orphans) — labels are the source of truth (no new required table). **Idle reaper under the manager lock** (avoids v1's reaper race). **Concurrency semaphore** acquired per drive.
- **`sandbox-refs.service.ts`** — host-maintained read-only reference clones bind-mounted at `/refs` (one clone per referenced repo, each with its own token; per-tenant dir). Satisfies "a channel can reference any other repo."
- **`sandbox.module.ts`** — composes the above; binds `CONTAINER_ENGINE`, and (when `ATLAS_SANDBOX_MODE=docker`) the docker `ENGINE_RUNNER` + `SANDBOX_PROVIDER`. Imported by `app/app.module.ts`.

## Build decomposition (Opus sub-agents, dependency-ordered)

- **D0 — Container substrate.** `CONTAINER_ENGINE` port + dockerode adapter + boot-memoized image builder + Dockerfile. *Gate:* build image, run a container, `exec echo`, confirm inner `docker info` succeeds.
- **D1 — Engine-in-container (transport).** Extract the EngineRunner vendor core into a shared module; build the bundled entrypoint (JSON→NDJSON, one turn); build `DockerEngineRunner`; add `RunEngineArgs.target`; introduce `ENGINE_RUNNER`; bind local/docker by flag. *Gate:* a real Claude turn exec'd in a container edits `/work`, streams events, returns `result` + `sessionId`; a second turn **resumes** the session.
- **D2 — Sandbox lifecycle + provider + all three exec paths.** `SandboxManager` (acquire/teardown, readiness, boot adoption, reaper, semaphore); `SANDBOX_PROVIDER` local/docker; route the driver (`ensureSandbox`/`TurnRunner`), **AutoFixStage** (port + `AutoFixContext.containerId`), and **AcceptanceGate** through the ports. *Gate:* offline driver/autofix tests pass with the ports in front; `atlas:gate --live` (docker mode) runs a turn in a container and opens a PR.
- **D3 — Networking + DinD.** Per-sandbox Docker network; inner-docker volume; privileged; `--user`/docker-group uid handling. *Gate:* an agent turn runs `docker compose up -d postgres` inside and a test connects.
- **D4 — Creds, `/refs`, isolation.** Creds on exec env (Anthropic/OpenAI/GitHub/OAuth); host-maintained `/refs` mount; confirm agent-home persists across turns + restart.
- **D5 — Wiring + verification + flag + cleanup.** Env validation: add `ATLAS_SANDBOX_MODE`/`ATLAS_SANDBOX_REBUILD`, adopt the orphaned generic vars (below), prune dead daemon/Redis ones. Compose `SandboxModule`; run `atlas:e2e` end-to-end with `ATLAS_SANDBOX_MODE=docker` → PR opened, **every turn ran in-container**. Unit + int tests; `local`-mode regression green.

## Env & flags (`_core/config/env/validation.ts`)

**Adopt the orphaned-but-relevant generic vars** (already defined, now unowned after the v1 deletion — reuse, don't duplicate): `DOCKER_SOCKET_PATH`, `REFS_ROOT`, `WORKSPACE_IMAGE`, `WORKSPACE_NETWORK`, `WORKSPACE_DEV_PORT`, `WORKSPACE_PORT_RANGE_START/_END`, `WORKSPACE_IDLE_TTL_MINUTES`, `WORKSPACE_MAX_PER_PROJECT`. **Add only genuinely-new:** `ATLAS_SANDBOX_MODE=local|docker` (default `local`) and `ATLAS_SANDBOX_REBUILD`. **Prune dead daemon/Redis vars:** `WORKSPACE_REDIS_URL`, `WORKSPACE_DAEMON_BUILD_VOLUME`, (and `WORKSPACE_RUNTIME` unless we want the sysbox reserve). Reuses existing `ATLAS_AGENT_HOME_ROOT`, `ATLAS_REPOS_ROOT`, `ATLAS_GITHUB_TOKEN`, engine-auth vars. (Matches the in-codebase `ATLAS_X ?? X` fallback convention in `local-git.service.ts`/`engine-home.ts`.)

## Networking & dev exposure (immediate follow-up — documented, not built)

Each sandbox attaches to its **own Docker network** (per-sandbox bridge = max isolation; a per-tenant shared network is the noted option if features must reach each other). Internet egress (LLM APIs) via default NAT; inner services on the inner-docker network. **Human-facing exposure** ("a sandbox I can test myself") is the next plan: a host **reverse proxy (Traefik/Caddy)** routing `‹feature›.‹tenant›.‹host›` → the sandbox, with automatic TLS and label-based discovery. This pass adds the per-sandbox network + discovery labels and records the design — but stands up no proxy. The orphaned `WORKSPACE_DEV_PORT`/`WORKSPACE_PORT_RANGE_*` vars are the published-port fallback if we want exposure before the proxy.

## Persistence

**No new required tables.** Container **labels** (`atlas.team`, `atlas.project`, `atlas.branch`, `atlas.job`) are the source of truth for boot adoption + reaping — robust across DB/host restarts. A lightweight `atlas_sandboxes` row (container id ↔ job + exposure URL) is deferred to the exposure follow-up.

## Reuse (don't reinvent)

`dockerode` + `@types/dockerode` already in `package.json` — no new dep. The EngineRunner vendor logic is **extracted + shared** (not duplicated) between host-local and the in-container entrypoint. NestJS DI ports throughout (`CONTAINER_ENGINE` / `ENGINE_RUNNER` / `SANDBOX_PROVIDER`), per the `nestjs-di-over-facades` convention. Design ideas carried forward (v1 is deleted, so these are concepts, not imports): boot-memoized image build, labels-as-source-of-truth adoption, host-maintained `/refs` reference library.

## Verification

- **Int:** image builds; container runs; `exec` streams; inner `docker info` ok (D0). One engine turn in-container edits `/work` + resumes a session (D1). DinD: `docker compose up -d postgres` inside + a test connects (D3).
- **Live substrate proof:** `atlas:gate --live` in docker mode runs a real turn in a container and opens a PR (D2).
- **End-to-end (the real proof):** `atlas:e2e --live` with `ATLAS_SANDBOX_MODE=docker` → grill → approve → multi-section build with **every plan/execute/review/fix turn via `docker exec`** → one PR. Behavioral-identical to the `local` run bar where turns ran.
- **Resume across restart:** kill mid-build, reboot → `SandboxManager` re-adopts by label and the driver resumes the open turn (parallels `driver.resume()`).
- **Concurrency:** two jobs at once → two containers on separate networks, semaphore cap respected.
- **Isolation smoke:** a dev server in sandbox-A is unreachable from sandbox-B.
- **`local`-mode regression:** full atlas suite green (default path unchanged).
- **Post-implement doc fix:** update `ATLAS_V2.md` (§6 W8-done, §8 git-host-side decision) + the `atlas-v2-clean-room-rebuild` memory (v1 deleted on `main`).

## Deferred / explicitly noted

Reverse-proxy exposure (immediate follow-up, designed above) · `atlas_sandboxes` table + exposure registry (with the proxy) · per-project custom images · per-tenant shared networks · authenticated private git submodules inside the sandbox · clone-in-container fallback (only if bind-mount uid/perf friction bites; macOS bind-mount perf is sidesteppable via a `node_modules` named volume or just using `local` mode for fast dev iteration).