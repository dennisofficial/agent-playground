import Joi from 'joi';

/**
 * The DAEMON's environment contract — DELIBERATELY MINIMAL. The daemon is the in-container NestJS app
 * that runs Claude/Codex engine turns inside an isolated sandbox with NO database, NO Slack, NO LLM
 * gate/extract models, NO roster. So unlike the host's `IEnvConfig` (validation.ts — Postgres, Slack,
 * gateway, JWT, Langfuse, …), the daemon needs only the handful of vars its verbatim engines + skill
 * loader + tools provider actually read at run time.
 *
 * Interface AND Joi rule are added together (required ⇔ non-optional field, `?:` ⇔ `.optional()`),
 * exactly as the host convention prescribes (validation.ts). Consumed by the daemon's `EnvService`.
 *
 * IMPORTANT — engine-read keys: `claude.engine.ts` reads WORKER_MODEL + AGENT_HOME_ROOT;
 * `codex.engine.ts` reads CODEX_MODEL + AGENT_HOME_ROOT; `skill-loader.service.ts` reads
 * AGENT_HOME_ROOT. The API keys (ANTHROPIC_API_KEY / OPENAI_API_KEY) are kept OPTIONAL like the host
 * keeps them: a per-run key arrives in the dispatch payload (Phase 5) and overrides the ambient env;
 * the ambient env is the dev/standalone fallback. The HTTP listen PORT is read directly from
 * process.env in main.ts (Cloud-Run/house convention), NOT via EnvService — declared here only so a
 * stray value validates instead of being rejected.
 */
export interface IDaemonEnvConfig {
  // System
  NODE_ENV?: string;

  // LLM provider keys — OPTIONAL: the per-run key (dispatch payload, Phase 5) overrides this; the
  // ambient env is the dev/standalone fallback. The SDKs read these lazily from process.env.
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;

  // Engine model knobs (defaults applied in the engines, so optional).
  WORKER_MODEL?: string; // claude.engine.ts: model ?? env.get('WORKER_MODEL')
  CODEX_MODEL?: string; // codex.engine.ts: model ?? env.get('CODEX_MODEL')

  // Root for the worker engines' per-agent config/state homes (CLAUDE_CONFIG_DIR / CODEX_HOME) and
  // the skill cache — pinned at the sandbox's workspace volume so transcripts/skills survive a
  // daemon restart. Baked to /workspace/.agent-home in the image; overridable.
  AGENT_HOME_ROOT?: string;

  // The sandbox's in-container repo root (the fresh clone). The daemon's git surface (Phase 4) cuts
  // per-session worktrees off this. Baked to /workspace/repo in the image; overridable.
  WORKSPACE_ROOT?: string;

  // The repo coordinates the host injects at container creation (Phase 11 clone-on-boot). The daemon's
  // `DaemonBootstrapService` clones WORKSPACE_REPO_URL (base WORKSPACE_BASE_BRANCH) into WORKSPACE_ROOT
  // on boot, before any turn runs. OPTIONAL: a dev/standalone daemon (no WORKSPACE_ID) doesn't clone;
  // WORKSPACE_BASE_BRANCH defaults to 'main' in the bootstrapper. Read directly from process.env by
  // `DaemonBootstrapService` (same pattern as WORKSPACE_ID); declared here so they validate.
  WORKSPACE_REPO_URL?: string;
  WORKSPACE_BASE_BRANCH?: string;

  // Redis connection URL (Phase 5) — the daemon connects OUT to it (the only network it needs) to
  // consume its command stream + stream turn events back. OPTIONAL: the client is lazy/resilient, so
  // the daemon boots with Redis absent (the consumer loop retries until it appears); unset → a
  // localhost default. The host's `IEnvConfig` carries the same key.
  REDIS_URL?: string;

  // The sandbox's OWN workspace id (the uuid that names this container), injected at container creation
  // (Phase 6). The daemon consumes only its own command stream `ws:{WORKSPACE_ID}:cmds`. Read directly
  // from process.env by the consumer loop (not a config default — a daemon with no WORKSPACE_ID is a
  // standalone/dev boot and simply doesn't start the loop). Declared here so it validates.
  WORKSPACE_ID?: string;

  // The short random bootstrap token the host issues at container creation (Phase 6), used to AUTH the
  // just-in-time credential pull (`ws:{WORKSPACE_ID}:cred-req`). Read directly from process.env by
  // `RedisGitCredentialProvider` (same pattern as WORKSPACE_ID). OPTIONAL: a dev/standalone daemon with
  // no host falls back to the env-PAT credential provider. Declared here so it validates.
  DAEMON_BOOTSTRAP_TOKEN?: string;

  // Git credential (the PAT path — `EnvGitCredentialProvider`). All OPTIONAL: a file:// fixture or an
  // already-public repo needs no token, and Phase 5 swaps in a Redis-pull credential impl. Read
  // directly from process.env by the provider (the daemon binds the host EnvService, typed over the
  // host IEnvConfig, which doesn't carry these keys), so they're declared here only to document + let
  // the schema validate them rather than the `.unknown(true)` catch-all silently passing typos.
  GIT_TOKEN?: string; // GitHub PAT for authenticated clone/fetch/push (GIT_CONFIG_* extraheader)
  GIT_AUTHOR_NAME?: string; // per-worktree commit author name (default 'Agent')
  GIT_AUTHOR_EMAIL?: string; // per-worktree commit author email (default 'agent@agents.noreply')

  // HTTP listen port (read directly from process.env in main.ts). Declared so it validates; the
  // daemon has no inbound HTTP yet (Redis-driven, Phase 5) — reserved for a future /healthz.
  PORT?: number;
}

export const daemonEnvValidation = Joi.object<IDaemonEnvConfig, true>({
  NODE_ENV: Joi.string().optional(),

  ANTHROPIC_API_KEY: Joi.string().optional(),
  OPENAI_API_KEY: Joi.string().optional(),

  WORKER_MODEL: Joi.string().optional(),
  CODEX_MODEL: Joi.string().optional(),

  AGENT_HOME_ROOT: Joi.string().optional().default('/workspace/.agent-home'),
  WORKSPACE_ROOT: Joi.string().optional().default('/workspace/repo'),

  WORKSPACE_REPO_URL: Joi.string().optional(),
  WORKSPACE_BASE_BRANCH: Joi.string().optional(),

  REDIS_URL: Joi.string().uri().optional(),
  WORKSPACE_ID: Joi.string().optional(),
  DAEMON_BOOTSTRAP_TOKEN: Joi.string().optional(),

  GIT_TOKEN: Joi.string().optional(),
  GIT_AUTHOR_NAME: Joi.string().optional(),
  GIT_AUTHOR_EMAIL: Joi.string().optional(),

  PORT: Joi.number().port().optional(),
})
  // The container env carries far more than the daemon validates (PATH, HOME, REDIS_URL in Phase 5,
  // a bootstrap token, inner-docker vars, …). Joi would otherwise REJECT every unknown key — allow
  // them through so the minimal contract validates the keys it cares about without policing the rest.
  .unknown(true);
