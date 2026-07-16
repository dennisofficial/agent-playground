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
  /** One org's GitHub App connect status (`GET /web/orgs/:orgId/github-app/status`). */
  orgGithubAppStatus: (orgId: string) =>
    ["org-github-app-status", orgId] as const,
  /** One repo's workspace profile (GET /web/orgs/:orgId/repos/:repoId/workspace-profile). */
  orgWorkspaceProfile: (orgId: string, repoId: string) =>
    ["org-workspace-profile", orgId, repoId] as const,
  /** One org's user-defined MCP servers + the read-only system tier (`GET /web/orgs/:orgId/mcp-servers`). */
  orgMcpServers: (orgId: string) => ["org-mcp-servers", orgId] as const,
  /** One org's connected repos (`GET /web/orgs/:orgId/repos`) — the create-job picker. */
  orgRepos: (orgId: string) => ["org-repos", orgId] as const,
  /** One repo's branches (`GET /web/orgs/:orgId/repos/:repoId/branches`) — the base-branch picker. */
  repoBranches: (orgId: string, repoId: string) =>
    ["repo-branches", orgId, repoId] as const,
  /** One thread's durable message log. */
  threadMessages: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["thread-messages", ref.orgId, ref.repoId, ref.jobId] as const,
  /** The caller's own composer draft for one job (`GET .../jobs/:jobId/draft`). Keyed by `jobId` alone — a
   *  uuid is globally unique, and the drafts realtime row carries no repoId to rebuild a fuller key from. */
  draft: (jobId: string) => ["draft", jobId] as const,
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
  /** One job's accumulated multi-file diff (`GET …/jobs/:jobId/diff`) — the Changes pane. */
  jobDiff: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["job-diff", ref.orgId, ref.repoId, ref.jobId] as const,
  /** One job's cheap numstat-only diff summary (`GET …/jobs/:jobId/diff/summary`) — the sidebar's +/- totals. */
  jobDiffSummary: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["job-diff-summary", ref.orgId, ref.repoId, ref.jobId] as const,
  /** The job worktree's tracked-file manifest (repo/tree). */
  repoTree: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["repo-tree", ref.orgId, ref.repoId, ref.jobId] as const,
  /** One repo file's content (repo/file). The 4-element prefix matches every open repo file for the thread. */
  repoFile: (
    ref: { orgId: string; repoId: string; jobId: string },
    path: string,
  ) => ["repo-file", ref.orgId, ref.repoId, ref.jobId, path] as const,
  /** One thread's `atlas-svc` supervised-process list. */
  threadServices: (ref: { orgId: string; repoId: string; jobId: string }) =>
    ["thread-services", ref.orgId, ref.repoId, ref.jobId] as const,
  /** Jobs spawned FROM one job (`GET …/jobs/:jobId/created`) — the job workspace's "Created jobs" panel. */
  jobCreated: (orgId: string, repoId: string, jobId: string) =>
    ["job-created", orgId, repoId, jobId] as const,
  /** One org's reusable house-style profiles (`GET /web/orgs/:orgId/convention-profiles`). */
  orgConventionProfiles: (orgId: string) =>
    ["org-convention-profiles", orgId] as const,
  /** One repo's attached house-style profile slug (`GET …/convention-profiles/repo/:repoId`). */
  repoConventionProfile: (orgId: string, repoId: string) =>
    ["repo-convention-profile", orgId, repoId] as const,
  /** One org's skills registry (`GET /web/orgs/:orgId/skills`). */
  orgSkills: (orgId: string) => ["org-skills", orgId] as const,
  /** One org's Claude subscription usage snapshot (`GET /web/orgs/:orgId/usage`). */
  orgUsage: (orgId: string) => ["org-usage", orgId] as const,
  /** One personal credential's own live Claude usage (`GET …/claude-credentials/:id/usage`). */
  orgCredentialUsage: (orgId: string, credentialId: string) =>
    ["org-credential-usage", orgId, credentialId] as const,
  /** One org's Claude credentials list (`GET /web/orgs/:orgId/claude-credentials`). */
  orgClaudeCredentials: (orgId: string) =>
    ["org-claude-credentials", orgId] as const,
  /** One org's decoded Codex account email (owner-only `GET /web/orgs/:orgId/credentials/codex`). */
  orgCodexAccount: (orgId: string) => ["org-codex-account", orgId] as const,
  /** The host box's live machine stats snapshot (`GET /web/host-stats`). Not org-scoped. */
  hostStats: () => ["host-stats"] as const,
  /** One window's bucketed host-stats history (`GET /web/host-stats/history?hours=`). Not org-scoped. */
  hostStatsHistory: (hours: number) => ["host-stats", "history", hours] as const,
};
