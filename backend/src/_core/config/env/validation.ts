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

  // LLM knobs (harness reads these; defaults applied in code, so all optional)
  CHAT_MODEL?: string;
  CHAT_TEMPERATURE?: number;
  WORKER_ENGINE?: string;
  WORKER_MODEL?: string;
  CODEX_MODEL?: string;

  // Board / data selectors
  BOARD?: string;
  ZERO_PROJECT?: string;

  // Harness (defaults applied in code, so all optional)
  HARNESS_SURFACE_ID?: string; // the single chat surface this pass (default 'tui:main')
  HARNESS_TEAM_ID?: string; // team tier for memory scoping (default 'local')
  CHANNEL_HYDRATE_LIMIT?: number; // channel messages re-loaded into memory at boot (default 500)
  HARNESS_TIMESTAMP_GAP_MS?: number; // time gap (ms) triggering a divider in LLM history (default 3600000 = 1h)
  GATE_MODEL?: string; // soft-gate model (default in code: Haiku)
  EXTRACT_MODEL?: string; // reconcile extraction model (default in code: Haiku)
  GUARD_MODEL?: string; // recursion-guard model (default in code: Haiku)
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
  // Directory worker engines are jailed to. No code default on purpose: dispatching a job without
  // it fails loudly rather than letting a worker loose in an arbitrary cwd.
  WORKER_ROOT?: string;
  // Root for per-project repo clones (code default: ~/.agent-playground/repos)
  REPOS_ROOT?: string;
  // Root for the worker engines' OWN config/state homes — CLAUDE_CONFIG_DIR (<root>/claude) and
  // CODEX_HOME (<root>/codex) are pinned here so subprocesses never read the developer's personal
  // ~/.claude / ~/.codex (deterministic across dev and deploy) and their session transcripts land
  // in a stable, durable location. Code default: <repoRoot>/.agent-home (gitignored). Point at a
  // persistent volume in deployment.
  AGENT_HOME_ROOT?: string;
  // Root for the shared READ-ONLY reference library — one clone per registered project (per team),
  // bind-mounted read-only into every sandbox at /refs so a worker can read the team's OTHER projects
  // ambiently (the "all my repos sit in ~/Developer" model). Host path: must be visible to BOTH the
  // slack-app (the writer) and the Docker daemon (the bind source), exactly like REPO_ROOT in DooD.
  // Code default: <homedir>/.agent-playground/refs. Point at a persistent volume in deployment.
  REFS_ROOT?: string;
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

  // JWT auth for the admin portal (all optional — portal is disabled until secrets are set)
  JWT_ACCESS_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  COOKIE_DOMAIN?: string;
  ADMIN_SEED_EMAIL?: string;
  ADMIN_SEED_PASSWORD?: string;

  // Slack surface (slack-app only; optional so api/tui boot without them — slack-app/main.ts
  // asserts both at boot)
  SLACK_BOT_TOKEN?: string; // xoxb- — Web API (chat.postMessage, reactions.add, users.info)
  SLACK_APP_TOKEN?: string; // xapp- — Socket Mode connection (connections:write)
  // Inbound transport: 'socket' (default — own Socket Mode connection, single-workspace dev) or
  // 'gateway' (tenant stacks — an HTTP listener fed by the gateway's team_id routing).
  SLACK_INBOUND?: string;
  SLACK_INBOUND_PORT?: number; // gateway mode's private listen port (per tenant)

  // Gateway (gateway app only; optional so the other apps boot without them — gateway/main.ts
  // asserts its required subset at boot). ONE OAuth-distributed Slack app, N workspaces.
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string; // request-signature verification on /slack/events + /slack/interactivity
  GATEWAY_SHARED_SECRET?: string; // bearer between gateway → tenant stacks' /slack/inbound
  GATEWAY_PUBLIC_URL?: string; // public base (OAuth redirect = <base>/slack/oauth)
  GATEWAY_PORT?: number; // default 4100
  // Dev-only (CLI seed, not the app): the dev workspace's tenant row (ears token + installer),
  // re-seeded on `db:seed` — socket-mode dev never OAuth-installs, so without it there's no
  // tenant row (boss check falls back to APPROVAL_BOSS_USER_ID). JSON:
  // {"teamId":"T0…","botToken":"xoxb-…","installedBy":"U0…"}. Lives in .env.personal.
  SLACK_TENANT_SEED?: string;
  CONTROL_POSTGRES_DB?: string; // control-plane DB name (default 'agent_control'; server coords from POSTGRES_*)
  TENANT_ENV_ROOT?: string; // where per-tenant env overlays are written (provisioner)
  TENANT_PORT_BASE?: number; // first inbound port allocated to tenant stacks (default 4200)
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

  // ── Atlas v2 (the clean-room rebuild under src/atlas/) ────────────────────────────────────────
  // Atlas's local execution substrate is host-only (no daemon, no Docker): it clones repos and cuts
  // per-feature git worktrees on the host, runs the Claude/Codex SDKs as subprocesses, and opens PRs
  // over fetch. Where a value already exists for v1 it is REUSED (REPOS_ROOT, AGENT_HOME_ROOT,
  // ANTHROPIC_API_KEY/OPENAI_API_KEY, SLACK_BOT_TOKEN/SLACK_APP_TOKEN) — these are the few net-new vars.
  //
  // ATLAS_REPOS_ROOT: root the per-feature worktree sandboxes clone into. Falls back to REPOS_ROOT,
  // then ~/.agent-playground/atlas-repos. Kept separate from v1's so the two substrates never collide.
  ATLAS_REPOS_ROOT?: string;
  // ATLAS_AGENT_HOME_ROOT: root for Atlas engines' OWN isolated CLAUDE_CONFIG_DIR/CODEX_HOME — never
  // the developer's personal ~/.claude / ~/.codex. Falls back to AGENT_HOME_ROOT, then
  // ~/.agent-playground/atlas-agent-home. Point at a persistent volume in deployment.
  ATLAS_AGENT_HOME_ROOT?: string;
  // ATLAS_ENGINE_AUTH_MODE: how Atlas engine turns authenticate — 'api_key' (default, the metered
  // ANTHROPIC_API_KEY / OPENAI auth) or 'subscription' (drive the run off a Claude Max / ChatGPT plan).
  ATLAS_ENGINE_AUTH_MODE?: 'api_key' | 'subscription';
  // ATLAS_CLAUDE_OAUTH_TOKEN: a `CLAUDE_CODE_OAUTH_TOKEN` for subscription-mode Claude turns (used
  // only when ATLAS_ENGINE_AUTH_MODE='subscription'). Strips ambient ANTHROPIC_API_KEY at the seam.
  ATLAS_CLAUDE_OAUTH_TOKEN?: string;
  // ATLAS_WORKER_MODEL / ATLAS_CODEX_MODEL: model overrides for Atlas engine turns. Fall back to the
  // v1 WORKER_MODEL / CODEX_MODEL, then the SDK defaults.
  ATLAS_WORKER_MODEL?: string;
  ATLAS_CODEX_MODEL?: string;
  // ATLAS_GITHUB_TOKEN: the GitHub token Atlas's PR client + authenticated git ops use. Rides in
  // GIT_CONFIG_* / an Authorization header per invocation — never in argv / .git/config. Falls back
  // to GITHUB_TOKEN. Unset → public-repo / no-PR flows only.
  ATLAS_GITHUB_TOKEN?: string;
  GITHUB_TOKEN?: string;
  // ATLAS_SLACK_BOT_TOKEN / ATLAS_SLACK_APP_TOKEN: Atlas's OWN thread-aware Slack adapter creds. Fall
  // back to the v1 SLACK_BOT_TOKEN / SLACK_APP_TOKEN (xoxb-/xapp-). Unset → the Slack surface is inert.
  ATLAS_SLACK_BOT_TOKEN?: string;
  ATLAS_SLACK_APP_TOKEN?: string;
  // ATLAS_SURFACE: which `ChatSurface` is bound as the CHAT_SURFACE (W6). 'slack' (default) → the real
  // thread-aware Slack adapter; 'agent' → the in-process programmatic surface a test/script drives Atlas
  // through (send → read replies → approve) with no Slack. Both providers are always constructed; only
  // the binding switches.
  ATLAS_SURFACE?: 'slack' | 'agent';
  // ── Atlas v2 ingress (W2 — the notification HTTP edge) ───────────────────────────────────────
  // ATLAS_HTTP_PORT: the port the Atlas HTTP app listens on (hosts POST /ingress/github + /webhook).
  // Default 4002 in code (kept off v1's slack-app :4001). Cloud Run injects PORT for v1, but Atlas v2
  // is its own process with its own port.
  ATLAS_HTTP_PORT?: number;
  // ATLAS_GITHUB_WEBHOOK_SECRET: the GitHub webhook secret — the GitHub `NotificationSource` adapter
  // HMAC-verifies `X-Hub-Signature-256` against it. Unset → the /ingress/github endpoint refuses every
  // request (401 unverifiable); never trusts an unsigned GitHub payload.
  ATLAS_GITHUB_WEBHOOK_SECRET?: string;
  // ATLAS_WEBHOOK_SECRET: the shared secret for the generic first-party webhook — the generic adapter
  // constant-time-compares the `X-Atlas-Webhook-Secret` header against it. Unset → /ingress/webhook
  // refuses every request (401 unverifiable).
  ATLAS_WEBHOOK_SECRET?: string;
  // Mechanical event filter (no-LLM dedup + rate-limit on EventStimulus). All optional; code defaults:
  //  - ATLAS_EVENT_DEDUP_WINDOW_S: drop a repeat of the same (team,project,source,dedupeKey) within
  //    this window (default 300s). Collapses redeliveries / storms grouped to one issue.
  //  - ATLAS_EVENT_RATE_LIMIT / _WINDOW_S: at most N admissions per key per window (default 5 / 60s) —
  //    guards a key that keeps mutating its dedupeKey from spawning unbounded jobs.
  ATLAS_EVENT_DEDUP_WINDOW_S?: number;
  ATLAS_EVENT_RATE_LIMIT?: number;
  ATLAS_EVENT_RATE_WINDOW_S?: number;
  // ── Atlas v2 section/phase driver (W4) ────────────────────────────────────────────────────────
  // Runaway guards on the deterministic driver — a sanity ceiling so a malformed plan can't drive an
  // unbounded build. Both optional with code defaults:
  //  - ATLAS_MAX_SECTIONS: the most sections one job may have (excess sections are skipped + flagged).
  //    Default 12. The approved section list is human-gated, so this is belt-and-braces.
  //  - ATLAS_MAX_PHASES_PER_SECTION: the most phases one section may lock (a longer planner output is
  //    truncated to this). Default 8 — keeps a section's build bounded.
  ATLAS_MAX_SECTIONS?: number;
  ATLAS_MAX_PHASES_PER_SECTION?: number;
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

  // LLM knobs
  CHAT_MODEL: Joi.string().optional(),
  CHAT_TEMPERATURE: Joi.number().optional(),
  WORKER_ENGINE: Joi.string().optional(),
  WORKER_MODEL: Joi.string().optional(),
  CODEX_MODEL: Joi.string().optional(),

  // Board / data selectors
  BOARD: Joi.string().optional(),
  ZERO_PROJECT: Joi.string().optional(),

  // Harness
  HARNESS_SURFACE_ID: Joi.string().optional(),
  HARNESS_TEAM_ID: Joi.string().optional(),
  CHANNEL_HYDRATE_LIMIT: Joi.number().integer().min(1).optional(),
  HARNESS_TIMESTAMP_GAP_MS: Joi.number().integer().min(1).optional(),
  GATE_MODEL: Joi.string().optional(),
  EXTRACT_MODEL: Joi.string().optional(),
  GUARD_MODEL: Joi.string().optional(),
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
  WORKER_ROOT: Joi.string().optional(),
  REPOS_ROOT: Joi.string().optional(),
  AGENT_HOME_ROOT: Joi.string().optional(),
  REFS_ROOT: Joi.string().optional(),
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

  // JWT auth for the admin portal
  JWT_ACCESS_SECRET: Joi.string().optional(),
  JWT_REFRESH_SECRET: Joi.string().optional(),
  COOKIE_DOMAIN: Joi.string().optional(),
  ADMIN_SEED_EMAIL: Joi.string().email().optional(),
  ADMIN_SEED_PASSWORD: Joi.string().optional(),

  // Slack surface
  SLACK_BOT_TOKEN: Joi.string().optional(),
  SLACK_APP_TOKEN: Joi.string().optional(),
  SLACK_INBOUND: Joi.string().valid('socket', 'gateway').optional(),
  SLACK_INBOUND_PORT: Joi.number().port().optional(),

  // Gateway
  SLACK_CLIENT_ID: Joi.string().optional(),
  SLACK_CLIENT_SECRET: Joi.string().optional(),
  SLACK_SIGNING_SECRET: Joi.string().optional(),
  SLACK_TENANT_SEED: Joi.string().optional(),
  GATEWAY_SHARED_SECRET: Joi.string().optional(),
  GATEWAY_PUBLIC_URL: Joi.string().uri().optional(),
  GATEWAY_PORT: Joi.number().port().optional(),
  CONTROL_POSTGRES_DB: Joi.string().optional(),
  TENANT_ENV_ROOT: Joi.string().optional(),
  TENANT_PORT_BASE: Joi.number().port().optional(),
  AVATAR_BASE_URL: Joi.string().uri().optional(),
  AVATAR_STYLE: Joi.string().valid('illustrated', 'realistic').optional(),

  // Langfuse observability
  LANGFUSE_PUBLIC_KEY: Joi.string().optional(),
  LANGFUSE_SECRET_KEY: Joi.string().optional(),
  LANGFUSE_BASE_URL: Joi.string().uri().optional(),
  LANGFUSE_TRACING_ENVIRONMENT: Joi.string().optional(),

  // Atlas v2 (host-only local substrate; reuses v1 values where they exist)
  ATLAS_REPOS_ROOT: Joi.string().optional(),
  ATLAS_AGENT_HOME_ROOT: Joi.string().optional(),
  ATLAS_ENGINE_AUTH_MODE: Joi.string()
    .valid('api_key', 'subscription')
    .optional(),
  ATLAS_CLAUDE_OAUTH_TOKEN: Joi.string().optional(),
  ATLAS_WORKER_MODEL: Joi.string().optional(),
  ATLAS_CODEX_MODEL: Joi.string().optional(),
  ATLAS_GITHUB_TOKEN: Joi.string().optional(),
  GITHUB_TOKEN: Joi.string().optional(),
  ATLAS_SLACK_BOT_TOKEN: Joi.string().optional(),
  ATLAS_SLACK_APP_TOKEN: Joi.string().optional(),
  ATLAS_SURFACE: Joi.string().valid('slack', 'agent').optional(),
  // Atlas v2 ingress (W2)
  ATLAS_HTTP_PORT: Joi.number().port().optional(),
  ATLAS_GITHUB_WEBHOOK_SECRET: Joi.string().optional(),
  ATLAS_WEBHOOK_SECRET: Joi.string().optional(),
  ATLAS_EVENT_DEDUP_WINDOW_S: Joi.number().integer().min(0).optional(),
  ATLAS_EVENT_RATE_LIMIT: Joi.number().integer().min(1).optional(),
  ATLAS_EVENT_RATE_WINDOW_S: Joi.number().integer().min(1).optional(),
  // Atlas v2 section/phase driver (W4) runaway guards
  ATLAS_MAX_SECTIONS: Joi.number().integer().min(1).optional(),
  ATLAS_MAX_PHASES_PER_SECTION: Joi.number().integer().min(1).optional(),
});
