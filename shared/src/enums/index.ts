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

// NOTE: the org's raw API keys (Anthropic / OpenAI / GitHub PAT) are typed columns on the
// `org_credentials` table, not an enum-keyed vault. Subscription OAuth (Claude/Codex) is multi-account
// and lives in the agent-credentials module (`agent_credentials`).

/**
 * An agent SDK a subscription account can log into. Distinct from the org's raw API keys: these are
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
