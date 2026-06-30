import Joi from 'joi';

export enum EAppEnv {
  LOCAL = 'local',
  STAGING = 'staging',
  PROD = 'production',
}

export enum ENodeEnv {
  DEV = 'development',
  PROD = 'production',
  TEST = 'test',
}

/**
 * Type-safe environment contract. Add a key here AND a matching Joi rule below at
 * the same time (required ⇔ non-optional field, `?:` ⇔ `.optional()`). Consumed by
 * `EnvService extends BaseEnvService<IEnvConfig>`.
 *
 * Seeded from the terminal playground's real env surface (playground/.env.example);
 * grows as the harness migrates in. DB/queue vars (POSTGRES_*, REDIS_*) get added
 * when the harness moves off local SQLite.
 */
export interface IEnvConfig {
  // System
  APP_ENV: EAppEnv;
  NODE_ENV: ENodeEnv;
  ENABLE_TIMESTAMP?: string;
  ENABLE_COLOR?: string;
  // The HTTP listen port is read directly from process.env.PORT in main.ts
  // (Cloud Run injects it per service), NOT via EnvService.

  // URLs
  BACKEND_HOST: string;
  FRONTEND_HOST: string; // admin web origin — credentialed CORS in api/main.ts

  // Postgres (TypeORM + pgvector)
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SSL_MODE?: string; // disable | require | verify-full (defaults by NODE_ENV)
  POSTGRES_POOL_MAX?: number;

  // Redis (Phase 5 — the host↔sandbox-daemon communication bus). The harness drives in-sandbox
  // daemons over Redis Streams (turn events) + pub/sub (aborts) + correlation-id req/reply (git RPCs).
  // OPTIONAL: the client is lazy/resilient, so the harness boots with Redis absent (containerized
  // sessions are simply unavailable until Redis appears); unset → a localhost default. Net-new infra —
  // a system service on the OVH deploy compose alongside Postgres.
  REDIS_URL?: string;

  // LLM providers — OPTIONAL since the pending-keys pass: a tenant stack boots key-less and the
  // keys arrive at runtime via the encrypted provider_keys store (LlmReadinessService feeds them
  // into process.env, which is what every SDK reads lazily). Env still wins when set (dev).
  // OPENAI_API_KEY powers semantic-memory fact embeddings (text-embedding-3-small).
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;

  // NOTE: model ids (chat chains AND agentic engine/Codex/brain sessions) are hardcoded code constants,
  // NOT env-configurable — env vars are for per-environment config, and the model choice isn't that.

  // Board / data selectors
  BOARD?: string;
  ZERO_PROJECT?: string;

  // Harness (defaults applied in code, so all optional)
  HARNESS_SURFACE_ID?: string; // the single chat surface this pass (default 'tui:main')
  HARNESS_TEAM_ID?: string; // team tier for memory scoping (default 'local')
  CHANNEL_HYDRATE_LIMIT?: number; // channel messages re-loaded into memory at boot (default 500)
  HARNESS_TIMESTAMP_GAP_MS?: number; // time gap (ms) triggering a divider in LLM history (default 3600000 = 1h)
  RECURSION_GUARD_ENABLED?: boolean; // false → disable the loop-detection guard (default: true)
  RECURSION_GUARD_WINDOW?: number; // rolling-window size for the guard (default: 12)
  TOOL_LOOP_GUARD_ENABLED?: boolean; // false → disable the tool-call loop guard (default: true)
  TOOL_LOOP_GUARD_THRESHOLD?: number; // identical tool+args calls in a turn before the Haiku check fires (default: 3)
  // The execute-approval dial — how strictly session execute turns are gated on board approval:
  // 'all' (default) = EVERY execute flip needs a linked board task in 'approved'/'done';
  // 'linked' = only board-linked sessions are gated (unlinked ad-hoc work stays autonomous);
  // 'off' = no mechanical gate (prompt-governed only). Tone down as trust builds.
  EXECUTION_APPROVAL_MODE: 'all' | 'linked' | 'off';
  // How the integration self-review (the PR-level pass after the draft PR opens) hands off:
  // 'advisory' (default) = the harness ALWAYS ships the PR to ready-for-Dennis and attaches any
  // findings as a PR comment — never gates, never loops, no employee in the ship path (max autonomy);
  // 'gated' = the harness parks the findings and seeds the decision owner to ship-or-fix themselves.
  INTEGRATION_REVIEW_MODE: 'advisory' | 'gated';
  // Max board tasks per team allowed in in-flight execution (executing + self_review) at once. The
  // autonomy throttle: approval never auto-starts execution, and when N tickets are approved at once
  // only this many owners are woken to execute — the rest wait in 'approved' and are picked up as
  // slots free (gradual token usage, no spike). Default: 3.
  MAX_CONCURRENT_EXECUTIONS?: number;
  // Slack user id allowed to rule on approval cards when the workspace has no OAuth installer
  // (tenant.installed_by is null on env-token dev workspaces). installed_by wins when set.
  APPROVAL_BOSS_USER_ID?: string;
  // Root for per-project repo clones (code default: the repo-relative, gitignored
  // <repoRoot>/.atlas-state/repos — see backend/src/app/state-root.ts).
  REPOS_ROOT?: string;
  // Root for the worker engines' OWN config/state homes — CLAUDE_CONFIG_DIR (<root>/claude) and
  // CODEX_HOME (<root>/codex) are pinned here so subprocesses never read the developer's personal
  // ~/.claude / ~/.codex (deterministic across dev and deploy) and their session transcripts land
  // in a stable, durable location. Code default: the repo-relative, gitignored
  // <repoRoot>/.atlas-state/agent-home. Point at a persistent volume in deployment.
  AGENT_HOME_ROOT?: string;
  // Root for the shared READ-ONLY reference library — one clone per registered project (per team),
  // bind-mounted read-only into every sandbox at /refs so a worker can read the team's OTHER projects
  // ambiently (the "all my repos sit in ~/Developer" model). Host path: must be visible to BOTH the
  // slack-app (the writer) and the Docker daemon (the bind source), exactly like REPO_ROOT in DooD.
  // No code default — unset → the /refs library is disabled. Point at a persistent volume in deployment.
  REFS_ROOT?: string;
  // Root for the operator GOLDEN-SEED dirs — non-secret gitignored files the worktree hydrator copies
  // into a fresh worktree, laid out as <ATLAS_GOLDEN_ROOT>/<orgId>/<slug>/<path>. Optional; unset → the
  // manifest's seed[] is skipped. (Secrets come from the encrypted store, NOT here.)
  ATLAS_GOLDEN_ROOT?: string;
  // Host-only dir for the worktree hydration sidecar (the forbidden-paths record commitAll's leak-scan
  // reads). Read directly from process.env by git/hydration-sidecar.ts; declared here for completeness.
  // Code default: the repo-relative, gitignored <repoRoot>/.atlas-state/hydration-state. Never under a
  // managed worktree.
  ATLAS_HYDRATION_STATE?: string;
  // ⚠️ DEPRECATED (v1 harness sandbox stack, removed in commit f82a748). The Atlas v2 Docker layer
  // (src/app/sandbox/) REUSES only `DOCKER_SOCKET_PATH` (via DOCKER_SOCKET_PATH ?? this),
  // `REFS_ROOT` (via REFS_ROOT ?? this), and `WORKSPACE_IMAGE` (the sandbox base-image tag). The
  // rest below (WORKSPACE_RUNTIME/REDIS_URL/NETWORK/DOCKER_STORAGE_DRIVER/DAEMON_BUILD_VOLUME/
  // PNPM_STORE_VOLUME/IDLE_TTL_MINUTES/MAX_PER_PROJECT/DEV_PORT/PORT_RANGE_*) are ORPHANED — no code
  // reads them. Safe to delete wholesale in a follow-up cleanup (interface + Joi schema together).
  // Sandbox lifecycle (Phase 6 — the host spawns per-workspace DinD sandboxes via dockerode).
  // ALL optional: containerized sessions are unavailable until set (dev/local runs locally, unchanged).
  DOCKER_SOCKET_PATH?: string; // host Docker socket the manager spawns sandboxes on (default /var/run/docker.sock)
  WORKSPACE_IMAGE?: string; // the sandbox base image (pin by digest in deploy); required to spawn a sandbox
  WORKSPACE_RUNTIME?: string; // OCI runtime for sandboxes (default 'runc'; reserve 'sysbox-runc' hardening)
  // The Redis URL the SANDBOX uses (NOT the host's REDIS_URL, which is often a host-only loopback like
  // 127.0.0.1:6380). Injected into each sandbox so the daemon reaches Redis by SERVICE DNS on the shared
  // network. Default `redis://agent-playground-redis:6379` (the compose service). (Phase 11)
  WORKSPACE_REDIS_URL?: string;
  // The Docker network each sandbox joins so the service-DNS Redis resolves from inside the container.
  // Default `agent-playground_default` (the compose default network). Sandboxes still publish NO ports. (Phase 11)
  WORKSPACE_NETWORK?: string;
  // The inner dockerd storage driver injected per environment. TEST/DEV-ONLY escape hatch: leave EMPTY
  // in production (auto → overlay2 on a real Linux host); set `vfs` ONLY on Docker Desktop where
  // overlay-on-overlay can't mount. A Linux smoke test asserts real workspaces use overlay2, so vfs
  // can't silently become the prod default.
  WORKSPACE_DOCKER_STORAGE_DRIVER?: string;
  // The named Docker volume holding the Linux-built daemon (`dist` + node_modules + @workspace dists),
  // produced by `pnpm daemon:build` and mounted read-only at /daemon in every sandbox — so the daemon
  // is MOUNTED, never baked into the (generic) image. Default `agent-daemon-build`.
  WORKSPACE_DAEMON_BUILD_VOLUME?: string;
  // The persistent pnpm-store volume the daemon build reuses (frozen-lockfile install ≈ no-op when
  // unchanged). Default `agent-pnpm-store`. Read by the boot self-provisioner (WorkspaceProvisionerService).
  WORKSPACE_PNPM_STORE_VOLUME?: string;
  // Workstation lifecycle hardening (Phase 3 — per-branch workstations accumulate, so a reaper + a cap).
  //  - WORKSPACE_IDLE_TTL_MINUTES: how long a CLEAN, session-less workstation may sit idle before the idle
  //    reaper destroys it (default 1440 = 24h). A workstation is only reaped when it ALSO has no open
  //    sessions and the daemon reports it reap-safe (no unpushed commits, no uncommitted changes).
  //  - WORKSPACE_MAX_PER_PROJECT: the cap on live branch-scoped workstations per (team, project). A
  //    create_workspace past the cap is REFUSED with guidance to remove an idle one first — never
  //    auto-evicted (auto-eviction risks destroying a clone with unpushed work). Default 8.
  WORKSPACE_IDLE_TTL_MINUTES?: number;
  WORKSPACE_MAX_PER_PROJECT?: number;
  // Dev-server exposure (Phase 2 — each workstation publishes ONE localhost-only port so Dennis can VIEW
  // its inner-compose dev server at http://localhost:<allocated>). All optional, defaults applied in
  // ContainerManagerService:
  //  - WORKSPACE_DEV_PORT: the container-side port the sandbox publishes (the convention the agent targets —
  //    run the dev server in the inner compose published to 0.0.0.0:<this>). Default 7000.
  //  - WORKSPACE_PORT_RANGE_START / _END: the host-side pool the manager allocates the published port from
  //    (the lowest free port not already on a `com.agent.devport` label — Docker labels are the durable
  //    source of truth, so it survives a restart and never double-binds). Defaults 39000..39999. Pool
  //    exhausted → the workstation is created WITHOUT a published port (exposure is best-effort).
  WORKSPACE_DEV_PORT?: number;
  WORKSPACE_PORT_RANGE_START?: number;
  WORKSPACE_PORT_RANGE_END?: number;
  // Boot self-provisioning (WorkspaceProvisionerService) — the slack-app builds the base image + daemon
  // volume itself at boot, so a deploy needs no manual `pnpm daemon:build`. ALL optional:
  //  - REPO_ROOT: the host repo root the build context + `/src` bind-mount resolve against (default: the
  //    monorepo root found by walking up from the compiled module). Set it only when the slack-app runs
  //    in a container whose repo path differs from the HOST path the Docker daemon sees.
  //  - REBUILD_IMAGE: force a base-image rebuild even when it already exists (default: build only if missing).
  //  - SKIP_DAEMON_BUILD: skip the boot daemon rebuild and reuse the existing volume (fast restarts for
  //    devs not touching daemon code; the entry-file presence check still gates spawning).
  REPO_ROOT?: string;
  REBUILD_IMAGE?: boolean;
  SKIP_DAEMON_BUILD?: boolean;
  // 32-byte key (base64 or hex) encrypting stored GitHub tokens at rest. Unset → token writes
  // refuse loudly; local-only flows are unaffected.
  SECRETS_ENCRYPTION_KEY?: string;
  // Bearer token gating the admin REST endpoints (projects/tokens). Unset → admin API disabled.
  ADMIN_API_TOKEN?: string;

  // JWT auth for the Atlas web console (/auth/*). Optional in the SHARED schema (slack-app / api boot
  // without them), but the Atlas HTTP app's JwtModule factory FAILS FAST if the two secrets are unset —
  // its auth guard is global. COOKIE_DOMAIN scopes the session cookies in deploy (host-only in dev).
  // ADMIN_SEED_* provisions an approved admin on boot (a guaranteed way in; registration is open but
  // new accounts start blocked until approved).
  JWT_ACCESS_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  COOKIE_DOMAIN?: string;
  ADMIN_SEED_EMAIL?: string;
  ADMIN_SEED_PASSWORD?: string;

  // Public base URL of the employee avatar tree (web/public/avatars — e.g. the repo's
  // raw.githubusercontent URL, later the hosted web app). Unset → messages post without icons.
  // Convention: <base>/<style>/<botId>.png
  AVATAR_BASE_URL?: string;
  AVATAR_STYLE?: string; // 'illustrated' (default) | 'realistic' — the feature toggle

  // Langfuse observability (optional — pending-keys mode; @core/tracing self-disables when absent).
  // The Langfuse OTEL SDK reads all four directly from process.env at bootstrap.
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_TRACING_ENVIRONMENT?: string; // tags traces by deployment env (e.g. 'development')

  // ── Atlas v2 (the clean-room rebuild under src/app/) ────────────────────────────────────────
  // Atlas's local execution substrate is host-only (no daemon, no Docker): it clones repos and cuts
  // per-feature git worktrees on the host, runs the Claude/Codex SDKs as subprocesses, and opens PRs
  // over fetch. Where a value already exists for v1 it is REUSED (REPOS_ROOT, AGENT_HOME_ROOT,
  // ANTHROPIC_API_KEY/OPENAI_API_KEY, SLACK_BOT_TOKEN/SLACK_APP_TOKEN) — these are the few net-new vars.
  //
  // REPOS_ROOT / AGENT_HOME_ROOT (declared above) — the root the per-feature worktree sandboxes
  // clone into, and the root for the engines' OWN isolated CLAUDE_CONFIG_DIR/CODEX_HOME.
  // The SDK harness (coding-session engine) runs SUBSCRIPTION-ONLY — there is no api_key mode and no
  // ENGINE_AUTH_MODE. These are the local-dev fallback secrets (deployed orgs carry per-org secrets):
  // CLAUDE_OAUTH_TOKEN: a `CLAUDE_CODE_OAUTH_TOKEN` for Claude turns. Strips ambient ANTHROPIC_API_KEY
  // at the seam so the OAuth token wins (the metered API would otherwise outrank it).
  CLAUDE_OAUTH_TOKEN?: string;
  // CODEX_OAUTH_TOKEN: the Codex subscription secret (auth.json / token) for Codex turns.
  CODEX_OAUTH_TOKEN?: string;
  // GITHUB_TOKEN: the GitHub token Atlas's PR client + authenticated git ops use. Rides in
  // GIT_CONFIG_* / an Authorization header per invocation — never in argv / .git/config.
  // Unset → public-repo / no-PR flows only.
  GITHUB_TOKEN?: string;
  // SURFACE: which `ChatSurface` is bound as the CHAT_SURFACE. 'web' (default) → the SSE + REST web
  // adapter (GET /web/events SSE, POST /web/say, POST /web/approve, GET /web/thread), the production
  // surface; 'agent' → the in-process programmatic surface a test/script drives Atlas through (send →
  // read replies → approve) with no HTTP. Both surfaces are always constructed; only the binding switches.
  SURFACE?: 'web' | 'agent';
  // ── Atlas v2 ingress (W2 — the notification HTTP edge) ───────────────────────────────────────
  // HTTP_PORT: the port the Atlas HTTP app listens on (hosts POST /ingress/github + /webhook).
  // Default 4002 in code (kept off v1's slack-app :4001). Cloud Run injects PORT for v1, but Atlas v2
  // is its own process with its own port.
  HTTP_PORT?: number;
  // GITHUB_WEBHOOK_SECRET: the GitHub webhook secret — the GitHub `NotificationSource` adapter
  // HMAC-verifies `X-Hub-Signature-256` against it. Unset → the /ingress/github endpoint refuses every
  // request (401 unverifiable); never trusts an unsigned GitHub payload.
  GITHUB_WEBHOOK_SECRET?: string;
  // WEBHOOK_SECRET: the shared secret for the generic first-party webhook — the generic adapter
  // constant-time-compares the `X-Atlas-Webhook-Secret` header against it. Unset → /ingress/webhook
  // refuses every request (401 unverifiable).
  WEBHOOK_SECRET?: string;
  // Mechanical event filter (no-LLM dedup + rate-limit on EventStimulus). All optional; code defaults:
  //  - EVENT_DEDUP_WINDOW_S: drop a repeat of the same (team,project,source,dedupeKey) within
  //    this window (default 300s). Collapses redeliveries / storms grouped to one issue.
  //  - EVENT_RATE_LIMIT / _WINDOW_S: at most N admissions per key per window (default 5 / 60s) —
  //    guards a key that keeps mutating its dedupeKey from spawning unbounded jobs.
  EVENT_DEDUP_WINDOW_S?: number;
  EVENT_RATE_LIMIT?: number;
  EVENT_RATE_WINDOW_S?: number;
  // ── Atlas v2 section/phase driver (W4) ────────────────────────────────────────────────────────
  // Runaway guards on the deterministic driver — a sanity ceiling so a malformed plan can't drive an
  // unbounded build. Both optional with code defaults:
  //  - MAX_SECTIONS: the most sections one job may have (excess sections are skipped + flagged).
  //    Default 12. The approved section list is human-gated, so this is belt-and-braces.
  //  - MAX_PHASES_PER_SECTION: the most phases one section may lock (a longer planner output is
  //    truncated to this). Default 8 — keeps a section's build bounded.
  //  - MAX_PHASES_PER_BATCH: the most phases one execution batch may run in a single fresh-context
  //    session (the deterministic cap around the LLM batcher). Default 5.
  MAX_SECTIONS?: number;
  MAX_PHASES_PER_SECTION?: number;
  MAX_PHASES_PER_BATCH?: number;
  // Circuit breakers on the driver (issue #3) — abort + relay a runaway build. Both optional, code
  // defaults: PHASE_TIMEOUT_MS (per engine turn, default 20m) + JOB_TIMEOUT_MS (whole job,
  // checked at section boundaries, default 60m).
  PHASE_TIMEOUT_MS?: number;
  JOB_TIMEOUT_MS?: number;
  // PARK_TIMEOUT_MS: how long a mid-build park waits for the human before it fails + relays
  // (a park is between phases, so the phase/job timeouts don't cover it). Default 3600000 (60 min).
  PARK_TIMEOUT_MS?: number;
  // ORCHESTRATE_TRACKS: run each track as ONE orchestrator session that fans implementation out to
  // writer subagents (default ON). Set to "off" to fall back to the legacy LLM-batched per-step path.
  ORCHESTRATE_TRACKS?: string;
  // ── Atlas v2 scoping / grill (W3 — issue #1 tuning) ──────────────────────────────────────────
  // SCOPING_MODE: how the brain investigates the repo to GROUND the grill. 'read_only_tools'
  // (default) runs a strict read-only engine pass (Read/Glob/Grep, no Bash) over the clone; 'native_plan'
  // uses Claude's native plan mode. Either way scoping never writes; it just stops the brain interrogating
  // the operator for facts it can read.
  SCOPING_MODE?: 'read_only_tools' | 'native_plan';
  // SCOPING_TIMEOUT_MS: wall-clock budget for one scoping investigation pass before it aborts and
  // the brain grills without a digest. Default 120000 (2 min).
  SCOPING_TIMEOUT_MS?: number;

  // ── Atlas v2 dev/test tooling ─────────────────────────────────────────────────────────────────
  // Both optional, dev/test ONLY — never set in prod:
  //  - TEST_BRIDGE: when 'on', mounts the in-process HTTP test-bridge (`POST /test/*`) so an
  //    external driver can have a real conversation with a running Atlas (seed → say → approve →
  //    inspect job/thread). Any other value (or unset) → the bridge endpoints 404.
  //  - DISABLE_RESUME: when set (any truthy value), the section driver SKIPS its boot
  //    reconciliation sweep, so a fresh test instance doesn't re-attempt prior runs' stale jobs.
  TEST_BRIDGE?: 'on';
  DISABLE_RESUME?: string;

  // ── Atlas v2 Docker sandbox layer ──────────────────────────────────────────────────────────────
  //  Docker is the ONLY execution mode — every engine turn runs inside a per-feature container via
  //  `docker exec`. The former 'local' in-process path has been removed.
  //  - DOCKER_SOCKET_PATH: host Docker socket the manager drives (falls back to
  //    DOCKER_SOCKET_PATH, else dockerode's default /var/run/docker.sock).
  //  - SANDBOX_IMAGE: the sandbox base-image tag (default 'atlas-sandbox:latest'). Deliberately
  //    NOT v1's WORKSPACE_IMAGE — that often still points at the deleted v1 workspace base image.
  //  - SANDBOX_REBUILD: when set (any value), force a rebuild of the sandbox base image at boot.
  //  - REFS_ROOT: root for host-maintained read-only reference clones bind-mounted at /refs
  //    (falls back to REFS_ROOT).
  //  - MAX_CONCURRENT_SANDBOXES: cap on simultaneously-active sandboxes/turns (semaphore).
  //  - SANDBOX_IDLE_TTL_MS: idle window before an attached-but-quiet per-thread sandbox container
  //    is reaped to `detached` (worktree survives; next turn re-attaches). Default 12h.
  //  - SANDBOX_REAP_INTERVAL_MS: how often the idle reaper + PR-merge cleanup sweep runs. Default 30m.
  // Reuses the generic DOCKER_SOCKET_PATH / REFS_ROOT via the ATLAS_* ?? fallback above.
  // DOCKER_SOCKET_PATH / REFS_ROOT declared above (shared with v1).
  SANDBOX_IMAGE?: string;
  SANDBOX_REBUILD?: string;
  MAX_CONCURRENT_SANDBOXES?: number;
  SANDBOX_IDLE_TTL_MS?: number;
  SANDBOX_REAP_INTERVAL_MS?: number;
  //  - SANDBOX_REDIS_URL: the Redis URL the IN-CONTAINER engine uses to read its spec + stream events
  //    (reachable from the sandbox, e.g. redis://host.docker.internal:6380 in dev, redis://redis:6379 in
  //    prod over the internal bus). Falls back to REDIS_URL. Redis is the only engine transport (ADR 0001).
  SANDBOX_REDIS_URL?: string;
  //  - TURN_STALE_MS: how long an `active_turns` heartbeat may go quiet before the leader watchdog
  //    finalizes the turn 'failed' (engine container died). Default 90000.
  TURN_STALE_MS?: number;

  // ── Atlas v2 clustering / rolling-update ─────────────────────────────────────────────────────────
  //  The backend is a hard singleton (in-memory turn queues, provisioning lock, single realtime slot).
  //  Graceful rolling deploys use a Postgres advisory-lock leader election + a SIGTERM drain.
  //  - LEADER_POLL_INTERVAL_MS: how often a follower re-tries to acquire the advisory lock. Default 2000.
  //  - DRAIN_GRACE_MS: on SIGTERM, how long the leader waits for in-flight turns to finish before it
  //    stops waiting (over-cap turns die with the process → cold-resume next leader). Default 120000.
  //    MUST be < the container stop_grace_period or Docker SIGKILLs mid-drain.
  //  - ENGINE_BUNDLE_PATH: absolute path for the live-mounted engine bundle (a host-resolvable same-path
  //    location when the backend is containerized). Read directly from process.env by bundle-engine.ts;
  //    default <imageDir>/engine-entrypoint.mjs. Declared here for completeness.
  //  - REALTIME_SLOT_PREFIX: prefix for the per-instance realtime replication slot. Default pg_realtime_slot.
  LEADER_POLL_INTERVAL_MS?: number;
  DRAIN_GRACE_MS?: number;
  ENGINE_BUNDLE_PATH?: string;
  REALTIME_SLOT_PREFIX?: string;
}

export const envConfigValidation = Joi.object<IEnvConfig, true>({
  // System
  APP_ENV: Joi.string()
    .valid(...Object.values(EAppEnv))
    .optional()
    .default(EAppEnv.LOCAL),
  NODE_ENV: Joi.string()
    .valid(...Object.values(ENodeEnv))
    .optional()
    .default(ENodeEnv.DEV),
  ENABLE_TIMESTAMP: Joi.string().optional(),
  ENABLE_COLOR: Joi.string().optional(),

  // URLs
  BACKEND_HOST: Joi.string().uri().optional().default('http://localhost:4000'),
  FRONTEND_HOST: Joi.string().uri().optional().default('http://localhost:3000'),

  // Postgres (TypeORM + pgvector)
  POSTGRES_HOST: Joi.string().required(),
  POSTGRES_PORT: Joi.number().port().optional().default(5432),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SSL_MODE: Joi.string()
    .valid('disable', 'require', 'verify-full')
    .optional(),
  POSTGRES_POOL_MAX: Joi.number().integer().min(1).optional(),

  // Redis (Phase 5 host↔daemon bus)
  REDIS_URL: Joi.string().uri().optional(),

  // LLM providers (optional — pending-keys mode gates LLM turns until keys land at runtime)
  ANTHROPIC_API_KEY: Joi.string().optional(),
  OPENAI_API_KEY: Joi.string().optional(),

  // (Model ids are hardcoded code constants, not env-configurable — see the interface note.)

  // Board / data selectors
  BOARD: Joi.string().optional(),
  ZERO_PROJECT: Joi.string().optional(),

  // Harness
  HARNESS_SURFACE_ID: Joi.string().optional(),
  HARNESS_TEAM_ID: Joi.string().optional(),
  CHANNEL_HYDRATE_LIMIT: Joi.number().integer().min(1).optional(),
  HARNESS_TIMESTAMP_GAP_MS: Joi.number().integer().min(1).optional(),
  RECURSION_GUARD_ENABLED: Joi.boolean().optional(),
  RECURSION_GUARD_WINDOW: Joi.number().integer().min(1).optional(),
  TOOL_LOOP_GUARD_ENABLED: Joi.boolean().optional(),
  TOOL_LOOP_GUARD_THRESHOLD: Joi.number().integer().min(2).optional(),
  EXECUTION_APPROVAL_MODE: Joi.string()
    .valid('all', 'linked', 'off')
    .optional()
    .default('all'),
  INTEGRATION_REVIEW_MODE: Joi.string()
    .valid('advisory', 'gated')
    .optional()
    .default('advisory'),
  MAX_CONCURRENT_EXECUTIONS: Joi.number().integer().min(1).optional(),
  APPROVAL_BOSS_USER_ID: Joi.string().optional(),
  REPOS_ROOT: Joi.string().optional(),
  AGENT_HOME_ROOT: Joi.string().optional(),
  REFS_ROOT: Joi.string().optional(),
  ATLAS_GOLDEN_ROOT: Joi.string().optional(),
  ATLAS_HYDRATION_STATE: Joi.string().optional(),
  // Sandbox lifecycle (Phase 6)
  DOCKER_SOCKET_PATH: Joi.string().optional(),
  WORKSPACE_IMAGE: Joi.string().optional(),
  WORKSPACE_RUNTIME: Joi.string().optional(),
  // Phase 11 sandbox-reachability injection (Redis service-DNS URL, the joined network, inner-docker
  // storage driver). All optional with sensible compose defaults applied in ContainerManagerService.
  WORKSPACE_REDIS_URL: Joi.string().uri().optional(),
  WORKSPACE_NETWORK: Joi.string().optional(),
  WORKSPACE_DOCKER_STORAGE_DRIVER: Joi.string().allow('').optional(),
  WORKSPACE_DAEMON_BUILD_VOLUME: Joi.string().optional(),
  WORKSPACE_PNPM_STORE_VOLUME: Joi.string().optional(),
  // Phase 3 workstation lifecycle hardening (idle reaper TTL + per-(team,project) create cap). Both
  // optional with the defaults applied in ContainerManagerService.
  WORKSPACE_IDLE_TTL_MINUTES: Joi.number().integer().min(1).optional(),
  WORKSPACE_MAX_PER_PROJECT: Joi.number().integer().min(1).optional(),
  // Phase 2 dev-server exposure (container-side publish port + the host-side allocation pool). All
  // optional with the defaults (7000, 39000..39999) applied in ContainerManagerService.
  WORKSPACE_DEV_PORT: Joi.number().integer().min(1).max(65535).optional(),
  WORKSPACE_PORT_RANGE_START: Joi.number().integer().min(1).max(65535).optional(),
  WORKSPACE_PORT_RANGE_END: Joi.number().integer().min(1).max(65535).optional(),
  REPO_ROOT: Joi.string().optional(),
  REBUILD_IMAGE: Joi.boolean().optional(),
  SKIP_DAEMON_BUILD: Joi.boolean().optional(),
  SECRETS_ENCRYPTION_KEY: Joi.string().optional(),
  ADMIN_API_TOKEN: Joi.string().optional(),

  // JWT auth for the Atlas web console (optional in the shared schema; Atlas fails fast if unset)
  JWT_ACCESS_SECRET: Joi.string().optional(),
  JWT_REFRESH_SECRET: Joi.string().optional(),
  COOKIE_DOMAIN: Joi.string().optional(),
  ADMIN_SEED_EMAIL: Joi.string().email().optional(),
  ADMIN_SEED_PASSWORD: Joi.string().optional(),

  AVATAR_BASE_URL: Joi.string().uri().optional(),
  AVATAR_STYLE: Joi.string().valid('illustrated', 'realistic').optional(),

  // Langfuse observability
  LANGFUSE_PUBLIC_KEY: Joi.string().optional(),
  LANGFUSE_SECRET_KEY: Joi.string().optional(),
  LANGFUSE_BASE_URL: Joi.string().uri().optional(),
  LANGFUSE_TRACING_ENVIRONMENT: Joi.string().optional(),

  // Atlas v2 (host-only local substrate; reuses v1 values where they exist — REPOS_ROOT,
  // AGENT_HOME_ROOT declared above)
  CLAUDE_OAUTH_TOKEN: Joi.string().optional(),
  CODEX_OAUTH_TOKEN: Joi.string().optional(),
  GITHUB_TOKEN: Joi.string().optional(),
  SURFACE: Joi.string().valid('web', 'agent').optional(),
  // Atlas v2 ingress (W2)
  HTTP_PORT: Joi.number().port().optional(),
  GITHUB_WEBHOOK_SECRET: Joi.string().optional(),
  WEBHOOK_SECRET: Joi.string().optional(),
  EVENT_DEDUP_WINDOW_S: Joi.number().integer().min(0).optional(),
  EVENT_RATE_LIMIT: Joi.number().integer().min(1).optional(),
  EVENT_RATE_WINDOW_S: Joi.number().integer().min(1).optional(),
  // Atlas v2 section/phase driver (W4) runaway guards
  MAX_SECTIONS: Joi.number().integer().min(1).optional(),
  MAX_PHASES_PER_SECTION: Joi.number().integer().min(1).optional(),
  MAX_PHASES_PER_BATCH: Joi.number().integer().min(1).optional(),
  PHASE_TIMEOUT_MS: Joi.number().integer().min(1000).optional(),
  JOB_TIMEOUT_MS: Joi.number().integer().min(1000).optional(),
  PARK_TIMEOUT_MS: Joi.number().integer().min(1000).optional(),
  ORCHESTRATE_TRACKS: Joi.string().optional(),
  // Atlas v2 scoping / grill (W3 — issue #1)
  SCOPING_MODE: Joi.string().valid('read_only_tools', 'native_plan').optional(),
  SCOPING_TIMEOUT_MS: Joi.number().integer().min(1000).optional(),
  // Atlas v2 dev/test tooling (never prod)
  TEST_BRIDGE: Joi.string().valid('on').optional(),
  DISABLE_RESUME: Joi.string().optional(),
  // Atlas v2 Docker sandbox layer (DOCKER_SOCKET_PATH, REFS_ROOT declared above)
  SANDBOX_IMAGE: Joi.string().optional(),
  SANDBOX_REBUILD: Joi.string().optional(),
  MAX_CONCURRENT_SANDBOXES: Joi.number().integer().min(1).optional(),
  SANDBOX_IDLE_TTL_MS: Joi.number().integer().min(0).optional(),
  SANDBOX_REAP_INTERVAL_MS: Joi.number().integer().min(1000).optional(),
  SANDBOX_REDIS_URL: Joi.string().uri().optional(),
  TURN_STALE_MS: Joi.number().integer().min(1000).optional(),
  // Atlas v2 clustering / rolling-update
  LEADER_POLL_INTERVAL_MS: Joi.number().integer().min(250).optional(),
  DRAIN_GRACE_MS: Joi.number().integer().min(0).optional(),
  ENGINE_BUNDLE_PATH: Joi.string().optional(),
  REALTIME_SLOT_PREFIX: Joi.string().optional(),
});
