export enum EAgentProvider {
  /** Anthropic Claude subscription (Claude Code OAuth / setup-token). */
  CLAUDE = 'claude',
  /** OpenAI Codex / ChatGPT subscription (device-code OAuth / pasted auth.json). */
  CODEX = 'codex',
}

export enum EAgentCredentialKind {
  PERSONAL = 'personal',
  SETUP_TOKEN = 'setup_token',
}

export enum EAgentCredentialStatus {
  ACTIVE = 'active',
  NEEDS_REAUTH = 'needs_reauth',
  ERROR = 'error',
}
