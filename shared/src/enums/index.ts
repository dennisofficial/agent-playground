/** Lifecycle state of an organization. */
export enum EOrgStatus {
  ONBOARDING = 'onboarding',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/** A user's role within a single organization. */
export enum EOrgRole {
  OWNER = 'owner',
  MEMBER = 'member',
}

/** A user's platform-wide role. */
export enum EUserRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
}

/** Account lifecycle — new sign-ups are PENDING until an operator approves them. */
export enum EUserStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/**
 * Typed registry of every secret an org can store in the credentials vault. The vault is agnostic —
 * it stores/encrypts a ciphertext keyed by one of these values and attaches no meaning to any of them;
 * the consuming module (GitHub, the engine, …) is what interprets a given key. The value is the
 * on-the-wire / DB-enum representation, so adding a key is a schema migration, not a magic string.
 */
export enum ECredentialKey {
  /** GitHub Personal Access Token (`ghp_…` / `github_pat_…`). Consumed by the GitHub module. */
  GITHUB_PAT = 'github_pat',
  /** Anthropic API key. */
  ANTHROPIC_API_KEY = 'anthropic_api_key',
  /** OpenAI API key. */
  OPENAI_API_KEY = 'openai_api_key',
  // NOTE: Codex/Claude *subscription* auth is NOT a vault key — multi-account OAuth lives in the
  // agent-credentials module (`agent_credentials` table). The vault holds only single-valued secrets.
}

/**
 * An agent SDK a subscription account can log into. Distinct from the vault's raw API keys: these are
 * OAuth subscription logins (Claude.ai / ChatGPT), multi-account per org, refreshed over time.
 */
export enum EAgentProvider {
  /** Anthropic Claude subscription (Claude Code OAuth / setup-token). */
  CLAUDE = 'claude',
  /** OpenAI Codex / ChatGPT subscription (device-code OAuth / pasted auth.json). */
  CODEX = 'codex',
}

/**
 * How an agent credential was obtained. `personal` is a full OAuth login we can refresh; `setup_token`
 * is a pasted long-lived secret (Claude `sk-ant-oat…` token or a Codex `~/.codex/auth.json` blob).
 */
export enum EAgentCredentialKind {
  PERSONAL = 'personal',
  SETUP_TOKEN = 'setup_token',
}

/** Health of an agent credential — surfaced in the UI; `needs_reauth` means a refresh hard-failed. */
export enum EAgentCredentialStatus {
  ACTIVE = 'active',
  NEEDS_REAUTH = 'needs_reauth',
  ERROR = 'error',
}
