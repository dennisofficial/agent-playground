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

export interface IEnvConfig {
  APP_ENV: EAppEnv;
  NODE_ENV: ENodeEnv;
  ENABLE_COLOR?: string; // logger colour toggle; read via process.env, declared for documentation
  GIT_SHA?: string; // backend build commit (CI sha-<short>); unset locally → resolved to "dev"

  BACKEND_HOST: string;
  FRONTEND_HOST: string; // web origin — credentialed CORS in main.ts

  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SSL_MODE?: string; // disable | require | verify-full (defaults by NODE_ENV)

  REDIS_URL?: string;

  CLAUDE_OAUTH_AUTHORIZE_URL?: string;
  CLAUDE_OAUTH_CLIENT_ID?: string;
  CLAUDE_OAUTH_TOKEN_URL?: string;

  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;

  APPROVAL_BOSS_USER_ID?: string;

  REPOS_ROOT?: string;
  AGENT_HOME_ROOT?: string;
  REFS_ROOT?: string;
  SKILLS_ROOT?: string;
  ATLAS_HYDRATION_STATE?: string;
  ENGINE_APP_BUNDLE_PATH?: string;
  ENGINE_APP_MAP_PATH?: string;
  ENGINE_BUNDLE_PATH?: string;

  DOCKER_SOCKET_PATH?: string;
  SANDBOX_IMAGE?: string;
  WORKSPACE_IMAGE?: string;
  WORKSPACE_DOCKER_STORAGE_DRIVER?: string;
  SANDBOX_CPU_SHARES?: number;
  SANDBOX_MAX_CPUS?: number;
  SANDBOX_MAX_MEMORY_GB?: number;
  SANDBOX_MAX_PIDS?: number;
  SANDBOX_AGENT_NICE?: number;
  SANDBOX_REDIS_URL?: string;
  SANDBOX_BUS_NETWORK?: string;
  ATLAS_REPO_SLUG?: string;

  MCP_READER_PG_USER?: string;
  MCP_READER_PG_PASSWORD?: string;
  MCP_WRITER_PG_USER?: string;
  MCP_WRITER_PG_PASSWORD?: string;

  SECRETS_ENCRYPTION_KEY: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  ADMIN_API_TOKEN?: string; // gates the admin REST endpoints; unset → disabled
  COOKIE_DOMAIN?: string; // scopes session cookies across subdomains in deploy; host-only in dev
  PREVIEW_BASE_DOMAIN?: string; // e.g. `preview.byatlas.io`; unset → exposure disabled
  CADDY_ADMIN_SOCKET?: string; // Caddy admin unix socket path; default /srv/atlas/caddy/admin/admin.sock
  CADDY_CONTAINER_NAME?: string; // Caddy container to bridge into sandbox nets; default `atlas-caddy`
  PREVIEW_ID_SECRET?: string; // HMAC key for the previewId token; derives from SECRETS_ENCRYPTION_KEY if unset
  ADMIN_SEED_EMAIL?: string; // provisions the dev admin on boot (+ seeds); unset → no auto-seed
  ADMIN_SEED_PASSWORD?: string;
  GITHUB_WEBHOOK_SECRET?: string; // HMAC-verifies GitHub webhooks; unset → /ingress/github refuses all
  WEBHOOK_SECRET?: string; // shared secret for the generic webhook; unset → /ingress/webhook refuses all

  AVATAR_BASE_URL?: string;
  AVATAR_STYLE?: string;

  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_TRACING_ENVIRONMENT?: string;

  SURFACE?: 'web' | 'agent';
  HTTP_PORT?: number;

  EVENT_DEDUP_WINDOW_S?: number;
  EVENT_RATE_LIMIT?: number;
  EVENT_RATE_WINDOW_S?: number;

  PHASE_TIMEOUT_MS?: number;
  DRIVER_TRANSIENT_RETRY_MS?: number;
  TURN_STALE_MS?: number;
  TURN_STREAM_REAP_IDLE_MS?: number;
  ARCHIVE_INACTIVITY_TTL_MS?: number;

  TEST_BRIDGE?: 'on' | 'off';
  DISABLE_RESUME?: string;
  HARNESS_CHUNK_ROWS?: 'on' | 'off';
  MEMORY_AUTORECALL_DISABLED?: 'on' | 'off';
  INSTALL_AWARENESS_FILTER_DISABLED?: 'on' | 'off';
}

export const envConfigValidation = Joi.object<IEnvConfig, true>({
  APP_ENV: Joi.string()
    .valid(...Object.values(EAppEnv))
    .optional()
    .default(EAppEnv.LOCAL),
  NODE_ENV: Joi.string()
    .valid(...Object.values(ENodeEnv))
    .optional()
    .default(ENodeEnv.DEV),
  ENABLE_COLOR: Joi.string().optional(),
  GIT_SHA: Joi.string().optional(),

  BACKEND_HOST: Joi.string().uri().optional().default('http://localhost:4000'),
  FRONTEND_HOST: Joi.string().uri().optional().default('http://localhost:3000'),

  POSTGRES_HOST: Joi.string().required(),
  POSTGRES_PORT: Joi.number().port().optional().default(5432),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SSL_MODE: Joi.string().valid('disable', 'require', 'verify-full').optional(),

  REDIS_URL: Joi.string().uri().optional(),

  CLAUDE_OAUTH_AUTHORIZE_URL: Joi.string().uri().optional(),
  CLAUDE_OAUTH_CLIENT_ID: Joi.string().optional(),
  CLAUDE_OAUTH_TOKEN_URL: Joi.string().uri().optional(),

  GITHUB_APP_ID: Joi.string().optional(),
  GITHUB_APP_CLIENT_ID: Joi.string().optional(),
  GITHUB_APP_PRIVATE_KEY: Joi.string().optional(),

  APPROVAL_BOSS_USER_ID: Joi.string().optional(),

  REPOS_ROOT: Joi.string().optional(),
  AGENT_HOME_ROOT: Joi.string().optional(),
  REFS_ROOT: Joi.string().optional(),
  SKILLS_ROOT: Joi.string().optional(),
  ATLAS_HYDRATION_STATE: Joi.string().optional(),
  ENGINE_APP_BUNDLE_PATH: Joi.string().optional(),
  ENGINE_APP_MAP_PATH: Joi.string().optional(),
  ENGINE_BUNDLE_PATH: Joi.string().optional(),

  DOCKER_SOCKET_PATH: Joi.string().optional(),
  SANDBOX_IMAGE: Joi.string().optional(),
  WORKSPACE_IMAGE: Joi.string().optional(),
  WORKSPACE_DOCKER_STORAGE_DRIVER: Joi.string().allow('').optional(),
  SANDBOX_CPU_SHARES: Joi.number().integer().min(2).max(262144).optional(),
  SANDBOX_MAX_CPUS: Joi.number().positive().optional(),
  SANDBOX_MAX_MEMORY_GB: Joi.number().positive().optional(),
  SANDBOX_MAX_PIDS: Joi.number().integer().positive().optional(),
  SANDBOX_AGENT_NICE: Joi.number().integer().min(0).max(19).optional(),
  SANDBOX_REDIS_URL: Joi.string().uri().optional(),
  SANDBOX_BUS_NETWORK: Joi.string().optional(),
  ATLAS_REPO_SLUG: Joi.string().optional(),
  MCP_READER_PG_USER: Joi.string().optional(),
  MCP_READER_PG_PASSWORD: Joi.string().optional(),
  MCP_WRITER_PG_USER: Joi.string().optional(),
  MCP_WRITER_PG_PASSWORD: Joi.string().optional(),

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

  AVATAR_BASE_URL: Joi.string().uri().optional(),
  AVATAR_STYLE: Joi.string().valid('illustrated', 'realistic').optional(),

  LANGFUSE_PUBLIC_KEY: Joi.string().optional(),
  LANGFUSE_SECRET_KEY: Joi.string().optional(),
  LANGFUSE_BASE_URL: Joi.string().uri().optional(),
  LANGFUSE_TRACING_ENVIRONMENT: Joi.string().optional(),

  SURFACE: Joi.string().valid('web', 'agent').optional(),
  HTTP_PORT: Joi.number().port().optional(),

  EVENT_DEDUP_WINDOW_S: Joi.number().integer().min(0).optional(),
  EVENT_RATE_LIMIT: Joi.number().integer().min(1).optional(),
  EVENT_RATE_WINDOW_S: Joi.number().integer().min(1).optional(),

  PHASE_TIMEOUT_MS: Joi.number().integer().min(1).optional(),
  DRIVER_TRANSIENT_RETRY_MS: Joi.number().integer().min(0).optional(),
  TURN_STALE_MS: Joi.number().integer().min(1).optional(),
  TURN_STREAM_REAP_IDLE_MS: Joi.number().integer().min(1).optional(),
  ARCHIVE_INACTIVITY_TTL_MS: Joi.number().integer().min(1).optional(),

  TEST_BRIDGE: Joi.string().valid('on', 'off').optional(),
  DISABLE_RESUME: Joi.string().optional(),
  HARNESS_CHUNK_ROWS: Joi.string().valid('on', 'off').optional(),
  MEMORY_AUTORECALL_DISABLED: Joi.string().valid('on', 'off').optional(),
  INSTALL_AWARENESS_FILTER_DISABLED: Joi.string().valid('on', 'off').optional(),
});
