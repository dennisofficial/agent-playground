/** TanStack Query key factory for the `/web/*` data layer. Pure — safe to import from anywhere. */
export const qk = {
  /** The operator session (identity + orgs) from `GET /auth/session`. */
  session: () => ["session"] as const,
  /** Every thread across all the operator's orgs (`GET /web/threads`). */
  allJobs: () => ["all-threads"] as const,
  /** One org's members (`GET /web/orgs/:orgId/members`). */
  orgMembers: (orgId: string) => ["org-members", orgId] as const,
  /** One org's credential presence flags (`GET /web/orgs/:orgId/credentials`). */
  orgCredentials: (orgId: string) => ["org-credentials", orgId] as const,
  /** One org's worktree secret names + grants (`GET /web/orgs/:orgId/worktree-secrets`). */
  orgWorktreeSecrets: (orgId: string) =>
    ["org-worktree-secrets", orgId] as const,
  /** One org's connected repos (`GET /web/orgs/:orgId/repos`) — the create-job picker. */
  orgRepos: (orgId: string) => ["org-repos", orgId] as const,
  /** One repo's branches (`GET /web/orgs/:orgId/repos/:repoId/branches`) — the base-branch picker. */
  repoBranches: (orgId: string, repoId: string) =>
    ["repo-branches", orgId, repoId] as const,
  /** One thread's durable message log. */
  threadMessages: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["thread-messages", ref.orgId, ref.repoId, ref.jobId] as const,
  /** One thread's pipeline (job + sections). */
  threadPipeline: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["thread-pipeline", ref.orgId, ref.repoId, ref.jobId] as const,
  /** One thread's `/context` file listing (specs + artifacts). */
  threadContext: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["thread-context", ref.orgId, ref.repoId, ref.jobId] as const,
  /** One `/context` file's content. The 4-element prefix matches every open file for the thread. */
  threadContextFile: (
    ref: { orgId: string; repoId: string; jobId: string },
    path: string,
  ) => ["thread-context-file", ref.orgId, ref.repoId, ref.jobId, path] as const,
  /** One thread's `atlas-svc` supervised-process list. */
  threadServices: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["thread-services", ref.orgId, ref.repoId, ref.jobId] as const,
  /** Every repo across all the operator's orgs (the tickets repo picker). */
  allRepos: () => ["all-repos"] as const,
  /** One repo's board/backlog tickets (`GET /web/orgs/:orgId/repos/:repoId/tickets`). */
  ticketsList: (orgId: string, repoId: string) =>
    ["tickets-list", orgId, repoId] as const,
  /** One ticket's detail (deps + thread link). */
  ticketDetail: (orgId: string, repoId: string, ticketId: string) =>
    ["ticket-detail", orgId, repoId, ticketId] as const,
};
