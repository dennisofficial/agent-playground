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

  // LLM providers — OPTIONAL since the pending-keys pass: a tenant stack boots key-less and the
  // keys arrive at runtime via the encrypted provider_keys store (LlmReadinessService feeds them
  // into process.env, which is what every SDK reads lazily). Env still wins when set (dev).
  // OPENAI_API_KEY powers semantic-memory fact embeddings (text-embedding-3-small).
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;

  // LLM knobs (harness reads these; defaults applied in code, so all optional)
  CHAT_MODEL?: string;
  CHAT_TEMPERATURE?: number;
  CHAT_MAX_TOKENS?: number;
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
  DORMANCY_ENABLED?: boolean; // false → disable gate dormancy (default: true)
  DORMANCY_IGNORE_THRESHOLD?: number; // consecutive soft-gate ignores before a bot goes dormant (default: 3)
  // The execute-approval dial — how strictly session execute turns are gated on board approval:
  // 'all' (default) = EVERY execute flip needs a linked board task in 'approved'/'done';
  // 'linked' = only board-linked sessions are gated (unlinked ad-hoc work stays autonomous);
  // 'off' = no mechanical gate (prompt-governed only). Tone down as trust builds.
  EXECUTION_APPROVAL_MODE: 'all' | 'linked' | 'off';
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
  // Per-employee puppet apps' OAuth creds, JSON: {"alex":{"clientId":"…","clientSecret":"…"}, …}.
  // Used only by the puppet install callback (<base>/slack/puppet/oauth, botId in `state`).
  SLACK_PUPPET_OAUTH?: string;
  // Dev-only (CLI seed, not the app): puppet bot tokens re-seeded into slack_identities on
  // `db:seed`, JSON: {"teamId":"T0…","tokens":{"alex":"xoxb-…", …}}. Lives in .env.personal.
  SLACK_PUPPET_SEED?: string;
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

  // LLM providers (optional — pending-keys mode gates LLM turns until keys land at runtime)
  ANTHROPIC_API_KEY: Joi.string().optional(),
  OPENAI_API_KEY: Joi.string().optional(),

  // LLM knobs
  CHAT_MODEL: Joi.string().optional(),
  CHAT_TEMPERATURE: Joi.number().optional(),
  CHAT_MAX_TOKENS: Joi.number().optional(),
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
  DORMANCY_ENABLED: Joi.boolean().optional(),
  DORMANCY_IGNORE_THRESHOLD: Joi.number().integer().min(1).optional(),
  EXECUTION_APPROVAL_MODE: Joi.string()
    .valid('all', 'linked', 'off')
    .optional()
    .default('all'),
  MAX_CONCURRENT_EXECUTIONS: Joi.number().integer().min(1).optional(),
  APPROVAL_BOSS_USER_ID: Joi.string().optional(),
  WORKER_ROOT: Joi.string().optional(),
  REPOS_ROOT: Joi.string().optional(),
  AGENT_HOME_ROOT: Joi.string().optional(),
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
  SLACK_PUPPET_OAUTH: Joi.string().optional(),
  SLACK_PUPPET_SEED: Joi.string().optional(),
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
});
