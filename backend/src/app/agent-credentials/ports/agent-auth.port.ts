import type { EAgentCredentialKind, EAgentProvider } from '@workspace/shared';

/** The decrypted runtime auth for the selected account of a provider. */
export interface ResolvedAgentAuth {
  credentialId: string;
  provider: EAgentProvider;
  kind: EAgentCredentialKind;
  /**
   * Decrypted material to materialize into an engine home: Claude personal → the `.credentials.json`
   * JSON string; Claude setup_token → the raw `sk-ant-oat…` token; Codex → the `auth.json` blob.
   */
  material: string;
}

/**
 * What the (future) engine consumes to run a turn under a subscription account — the single read seam
 * into the agent-credentials module. Bound to {@link AGENT_AUTH_PORT}; the engine injects the token only,
 * so it never learns how the material is stored or refreshed.
 */
export interface AgentAuthPort {
  /**
   * Resolve the selected account's runtime auth for a provider, refreshing it first if near expiry.
   * Returns null when the org has no selected account for that provider.
   */
  resolve(orgId: string, provider: EAgentProvider): Promise<ResolvedAgentAuth | null>;
}

export const AGENT_AUTH_PORT = Symbol('AGENT_AUTH_PORT');
