/** TanStack Query key factory for the `/web/*` data layer. Pure — safe to import from anywhere. */
export const qk = {
  /** The operator session (identity + orgs) from `GET /auth/session`. */
  session: () => ['session'] as const,
  /** Every thread across all the operator's orgs (`GET /web/threads`). */
  allThreads: () => ['all-threads'] as const,
  /** One org's members (`GET /web/orgs/:orgId/members`). */
  orgMembers: (orgId: string) => ['org-members', orgId] as const,
  /** One org's credential presence flags (`GET /web/orgs/:orgId/credentials`). */
  orgCredentials: (orgId: string) => ['org-credentials', orgId] as const,
  /** One org's connected repos (`GET /web/orgs/:orgId/repos`) — the create-thread picker. */
  orgRepos: (orgId: string) => ['org-repos', orgId] as const,
  /** One thread's durable message log. */
  threadMessages: (ref: { orgId: string; repoId: string; threadId: string }) =>
    ['thread-messages', ref.orgId, ref.repoId, ref.threadId] as const,
  /** One thread's pipeline (job + sections). */
  threadPipeline: (ref: { orgId: string; repoId: string; threadId: string }) =>
    ['thread-pipeline', ref.orgId, ref.repoId, ref.threadId] as const,
  /** One thread's `/context` file listing (specs + artifacts). */
  threadContext: (ref: { orgId: string; repoId: string; threadId: string }) =>
    ['thread-context', ref.orgId, ref.repoId, ref.threadId] as const,
  /** One `/context` file's content. The 4-element prefix matches every open file for the thread. */
  threadContextFile: (ref: { orgId: string; repoId: string; threadId: string }, path: string) =>
    ['thread-context-file', ref.orgId, ref.repoId, ref.threadId, path] as const,
};
