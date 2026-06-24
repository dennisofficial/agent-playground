/** TanStack Query key factory for the `/web/*` data layer. Pure — safe to import from anywhere. */
export const qk = {
  // ── legacy channel layer (kept for the not-yet-deleted dead modules) ──
  channels: () => ['channels'] as const,
  channelMessages: (channel: string) => ['channel-messages', channel] as const,
  // ── multi-org ──
  /** The operator session (identity + orgs) from `GET /auth/session`. */
  session: () => ['session'] as const,
  /** Every thread across all the operator's orgs (`GET /web/threads`). */
  allThreads: () => ['all-threads'] as const,
  /** One org's members (`GET /web/orgs/:orgId/members`). */
  orgMembers: (orgId: string) => ['org-members', orgId] as const,
  /** One org's credential presence flags (`GET /web/orgs/:orgId/credentials`). */
  orgCredentials: (orgId: string) => ['org-credentials', orgId] as const,
};
