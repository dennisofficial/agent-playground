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
 * Type-safe environment contract for the Atlas backend. Add a key here AND a matching Joi rule below at
 * the same time (required ⇔ non-optional field, `?:` ⇔ `.optional()`). Consumed by
 * `EnvService extends BaseEnvService<IEnvConfig>`.
 *
 * PRINCIPLE (keep this list lean): an env var earns its place here ONLY if it is a real SECRET or a value
 * that genuinely DIFFERS between local and production. Pure config that's the same everywhere lives as a
 * code constant, not here; anything the app cannot run without is `.required()` so boot crashes loudly
 * instead of null-checking. Internal timing knobs exist here only where a test needs to inject a fast
 * value (grouped + labelled below) — they are never set in a real environment.
 *
 * Read directly from `process.env` (NOT via EnvService, so intentionally absent from this schema):
 *   - PORT / HTTP_PORT bootstrap in main.ts; ENABLE_COLOR/ENABLE_TIMESTAMP/APP_ENV in setup-logger.ts.
 *   - Prod-only path config with code defaults: ATLAS_GOLDEN_ROOT, MCP_HUB_BUNDLE_PATH,
 *     MCP_BRIDGE_BUNDLE_PATH (set by infra/docker-compose.prod.yml; each has a code default).
 *   - The dotenvx decrypt key DOTENV_PRIVATE_KEY_PRODUCTION_ENC (infra secret, not app config).
 *   - LLM/engine credentials (Anthropic + OpenAI keys, Claude + Codex subscription OAuth tokens, GitHub
 *     PAT): per-org encrypted `org_credentials` rows resolved via `CredentialResolver` — seeded in dev
 *     (`pnpm db:seed`, fed by `.env.seed.enc`), onboarded in prod. There is NO env fallback.
 *   - Model ids (chat chains + agentic engine/Codex/brain): hardcoded code constants — the model choice
 *     doesn't vary per environment.
 */
export interface IEnvConfig {
  // System
  APP_ENV: EAppEnv;
  NODE_ENV: ENodeEnv;
  ENABLE_COLOR?: string; // logger colour toggle; read via process.env, declared for documentation

  // URLs
  BACKEND_HOST: string;
  FRONTEND_HOST: string; // web origin — credentialed CORS in main.ts

  // Postgres (TypeORM + pgvector)
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SSL_MODE?: string; // disable | require | verify-full (defaults by NODE_ENV)

  // Redis (the host↔sandbox engine bus). OPTIONAL: the client is lazy/resilient; unset → a localhost
  // default (containerized turns are unavailable until Redis appears).
  REDIS_URL?: string;

  // Slack/approval boss user id (set in the shared dev config). installed_by wins when set.
  APPROVAL_BOSS_USER_ID?: string;

  // Path roots (differ dev↔prod; each has a code default). REPOS_ROOT: per-repo clones. AGENT_HOME_ROOT:
  // the engines' isolated CLAUDE_CONFIG_DIR/CODEX_HOME. REFS_ROOT: read-only /refs reference library.
  // SKILLS_ROOT: the central skills store bind-mounted read-write per-org at /skills.
  // ATLAS_HYDRATION_STATE: the worktree-hydration sidecar's host dir. ENGINE_BUNDLE_PATH: the live-mounted
  // engine bundle path (read via process.env by bundle-engine.ts; declared for completeness).
  REPOS_ROOT?: string;
  AGENT_HOME_ROOT?: string;
  REFS_ROOT?: string;
  SKILLS_ROOT?: string;
  ATLAS_HYDRATION_STATE?: string;
  ENGINE_BUNDLE_PATH?: string;

  // Docker sandbox layer. DOCKER_SOCKET_PATH: host socket (default /var/run/docker.sock). SANDBOX_IMAGE:
  // the sandbox base-image tag (default 'atlas-sandbox:latest'). WORKSPACE_IMAGE /
  // WORKSPACE_DOCKER_STORAGE_DRIVER: local Docker-Desktop knobs (the latter forces the inner dockerd to
  // `vfs`; EMPTY on a real Linux host).
  DOCKER_SOCKET_PATH?: string;
  SANDBOX_IMAGE?: string;
  WORKSPACE_IMAGE?: string;
  WORKSPACE_DOCKER_STORAGE_DRIVER?: string;
  // SANDBOX_REDIS_URL: the Redis URL the IN-CONTAINER engine uses (falls back to REDIS_URL).
  // SANDBOX_BUS_NETWORK: the internal Docker network each sandbox joins (`atlas-bus` in prod; unset in dev).
  SANDBOX_REDIS_URL?: string;
  SANDBOX_BUS_NETWORK?: string;

  // Secrets. SECRETS_ENCRYPTION_KEY (32-byte hex/base64) encrypts every `org_credentials` row at rest —
  // REQUIRED now that all credentials live there. JWT_* sign the web-console session cookies — REQUIRED
  // (the global auth guard can't boot without them). The rest gate optional features when unset.
  SECRETS_ENCRYPTION_KEY: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  ADMIN_API_TOKEN?: string; // gates the admin REST endpoints; unset → disabled
  COOKIE_DOMAIN?: string; // scopes session cookies across subdomains in deploy; host-only in dev
  // Sandbox preview exposure (see the exposure module). All optional — the feature is OFF (no routing,
  // no injected env) unless PREVIEW_BASE_DOMAIN is set, so dev/local is unchanged.
  PREVIEW_BASE_DOMAIN?: string; // e.g. `atlas.dltechnologies.co`; unset → exposure disabled
  CADDY_ADMIN_SOCKET?: string; // Caddy admin unix socket path; default /srv/atlas/caddy/admin/admin.sock
  CADDY_CONTAINER_NAME?: string; // Caddy container to bridge into sandbox nets; default `atlas-caddy`
  PREVIEW_ID_SECRET?: string; // HMAC key for the previewId token; derives from SECRETS_ENCRYPTION_KEY if unset
  ADMIN_SEED_EMAIL?: string; // provisions the dev admin on boot (+ seeds); unset → no auto-seed
  ADMIN_SEED_PASSWORD?: string;
  GITHUB_WEBHOOK_SECRET?: string; // HMAC-verifies GitHub webhooks; unset → /ingress/github refuses all
  WEBHOOK_SECRET?: string; // shared secret for the generic webhook; unset → /ingress/webhook refuses all

  // Employee avatars. AVATAR_BASE_URL: public base of the avatar tree; unset → no icons. AVATAR_STYLE:
  // 'illustrated' (default) | 'realistic'.
  AVATAR_BASE_URL?: string;
  AVATAR_STYLE?: string;

  // Langfuse observability (optional — tracing self-disables when absent; the OTEL SDK reads these
  // directly from process.env at bootstrap).
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_TRACING_ENVIRONMENT?: string;

  // Surface + ingress. SURFACE: which `ChatSurface` binds as CHAT_SURFACE — 'web' (default) is the SSE +
  // REST adapter; 'agent' is the in-process surface a test drives. HTTP_PORT: the listen port (default
  // 4002 in main.ts; set in prod).
  SURFACE?: 'web' | 'agent';
  HTTP_PORT?: number;

  // Event filter windows — INTERNAL knobs with code defaults (dedup 300s, rate 5 / 60s). Present only so
  // the event-filter spec can inject small windows; never set in a real environment.
  EVENT_DEDUP_WINDOW_S?: number;
  EVENT_RATE_LIMIT?: number;
  EVENT_RATE_WINDOW_S?: number;

  // Driver/sandbox timing — INTERNAL knobs with code defaults, present only so tests can inject fast
  // values (the circuit-breaker, retry-backoff, and watchdog specs); never set in a real environment.
  //  - PHASE_TIMEOUT_MS: per-orchestrator-turn wall-clock budget (default 60m).
  //  - DRIVER_TRANSIENT_RETRY_MS: base backoff between transient drive retries (default 2000).
  //  - TURN_STALE_MS: heartbeat-quiet window before the watchdog fails a turn (default 90000).
  //  - TURN_STREAM_REAP_IDLE_MS: untouched window before a turn's orphan streams may be reaped (default 300000).
  //  - REVIEW_LENS_CONCURRENCY: total in-flight review-lens turns cap for a builder's post-build review
  //    fan-out (the `async-sema` semaphore `runReviewChildren` bounds ALL lens turns with); default 8.
  PHASE_TIMEOUT_MS?: number;
  DRIVER_TRANSIENT_RETRY_MS?: number;
  TURN_STALE_MS?: number;
  TURN_STREAM_REAP_IDLE_MS?: number;
  REVIEW_LENS_CONCURRENCY?: number;

  // Dev/test tooling (never live in prod). TEST_BRIDGE: 'off' opts a non-prod env out of the `/test/*`
  // bridge (gating is NODE_ENV-driven; hard-off in prod). DISABLE_RESUME: skip the driver's boot
  // reconciliation sweep (documented parallel-tuning safety gate). HARNESS_CHUNK_ROWS: 'off' quiets the
  // injected system-notice transcript rows.
  TEST_BRIDGE?: 'on' | 'off';
  DISABLE_RESUME?: string;
  HARNESS_CHUNK_ROWS?: 'on' | 'off';
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
  POSTGRES_SSL_MODE: Joi.string().valid('disable', 'require', 'verify-full').optional(),

  // Redis (host↔sandbox engine bus)
  REDIS_URL: Joi.string().uri().optional(),

  APPROVAL_BOSS_USER_ID: Joi.string().optional(),

  // Path roots (differ dev↔prod; code defaults)
  REPOS_ROOT: Joi.string().optional(),
  AGENT_HOME_ROOT: Joi.string().optional(),
  REFS_ROOT: Joi.string().optional(),
  SKILLS_ROOT: Joi.string().optional(),
  ATLAS_HYDRATION_STATE: Joi.string().optional(),
  ENGINE_BUNDLE_PATH: Joi.string().optional(),

  // Docker sandbox layer
  DOCKER_SOCKET_PATH: Joi.string().optional(),
  SANDBOX_IMAGE: Joi.string().optional(),
  WORKSPACE_IMAGE: Joi.string().optional(),
  WORKSPACE_DOCKER_STORAGE_DRIVER: Joi.string().allow('').optional(),
  SANDBOX_REDIS_URL: Joi.string().uri().optional(),
  SANDBOX_BUS_NETWORK: Joi.string().optional(),

  // Secrets
  SECRETS_ENCRYPTION_KEY: Joi.string().required(),
  JWT_ACCESS_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  ADMIN_API_TOKEN: Joi.string().optional(),
  COOKIE_DOMAIN: Joi.string().optional(),
  PREVIEW_BASE_DOMAIN: Joi.string().optional(),
  CADDY_ADMIN_SOCKET: Joi.string().optional(),
  CADDY_CONTAINER_NAME: Joi.string().optional(),
  PREVIEW_ID_SECRET: Joi.string().optional(),
  ADMIN_SEED_EMAIL: Joi.string().email().optional(),
  ADMIN_SEED_PASSWORD: Joi.string().optional(),
  GITHUB_WEBHOOK_SECRET: Joi.string().optional(),
  WEBHOOK_SECRET: Joi.string().optional(),

  // Avatars
  AVATAR_BASE_URL: Joi.string().uri().optional(),
  AVATAR_STYLE: Joi.string().valid('illustrated', 'realistic').optional(),

  // Langfuse observability
  LANGFUSE_PUBLIC_KEY: Joi.string().optional(),
  LANGFUSE_SECRET_KEY: Joi.string().optional(),
  LANGFUSE_BASE_URL: Joi.string().uri().optional(),
  LANGFUSE_TRACING_ENVIRONMENT: Joi.string().optional(),

  // Surface + ingress
  SURFACE: Joi.string().valid('web', 'agent').optional(),
  HTTP_PORT: Joi.number().port().optional(),

  // Event-filter windows (internal test seams)
  EVENT_DEDUP_WINDOW_S: Joi.number().integer().min(0).optional(),
  EVENT_RATE_LIMIT: Joi.number().integer().min(1).optional(),
  EVENT_RATE_WINDOW_S: Joi.number().integer().min(1).optional(),

  // Driver/sandbox timing (internal test seams)
  PHASE_TIMEOUT_MS: Joi.number().integer().min(1).optional(),
  DRIVER_TRANSIENT_RETRY_MS: Joi.number().integer().min(0).optional(),
  TURN_STALE_MS: Joi.number().integer().min(1).optional(),
  TURN_STREAM_REAP_IDLE_MS: Joi.number().integer().min(1).optional(),
  REVIEW_LENS_CONCURRENCY: Joi.number().integer().min(1).optional(),

  // Dev/test tooling (never prod)
  TEST_BRIDGE: Joi.string().valid('on', 'off').optional(),
  DISABLE_RESUME: Joi.string().optional(),
  HARNESS_CHUNK_ROWS: Joi.string().valid('on', 'off').optional(),
});
