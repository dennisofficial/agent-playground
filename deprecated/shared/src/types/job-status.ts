export type JobHaltKind =
  | 'failed'
  | 'blocked_credentials'
  | 'incomplete'
  | 'session_limit' // parked on a Claude session/usage limit; auto-resumes at resumeAt
  | 'codex_review_unavailable'; // parked on a master_review Codex outage (network/auth-to-Codex); auto-resumes on the resume clock, or the operator can 'ship without review'.

export type JobHalt = {
  kind: JobHaltKind;
  /** Short human string (what `relayFailure` already computes via `shortReason`). */
  reason: string;
  /** ISO timestamp the halt was recorded. */
  at: string;
  /** ISO reset timestamp; when set, the lane auto-resumes once it passes (session_limit halts). */
  resumeAt?: string;
};
