/**
 * Web SECRET-INPUT card payload — the secure request the repo-onboarding brain poses via the
 * `request_secret` tool when it needs an env-file secret value (e.g. `DATABASE_URL`). The web client
 * renders a masked password field + submit; the operator's value is POSTed to
 * `…/threads/:jobId/provide-secret`, which writes it straight to the encrypted `WorkspaceSecretFileStore`
 * and creates the owner grant. The value is therefore NEVER part of this card, the transcript, or any
 * brain tool I/O — the card holds only the request metadata + lifecycle timestamps, and once provided the
 * client renders a compact "✓ NAME provided" state.
 *
 * Pure — no I/O, no NestJS. Mirrors `web-question-card.ts` but is deliberately VALUE-FREE.
 */

/** A rendered web secret-input card — posted to the surface transcript + persisted as a durable card row. */
export interface WebSecretInputCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'secret_input_card';
  jobId: string;
  /** Stable key for this request (the card row's `ts`); the provide POST echoes it back. */
  requestId: string;
  /** The secret's name (the secret file's display `label`); shown to the operator, never the value. For an
   *  ephemeral request this is a display LABEL only (e.g. `GCLOUD_AUTH_CODE`) — nothing is keyed by it. */
  name: string;
  /**
   * The worktree-relative destination the secret will be rendered to in build threads (e.g. `.env`).
   * Absent for an EPHEMERAL request (there is no durable destination — see {@link ephemeral}/{@link deliver_to}).
   */
  path?: string;
  /**
   * EPHEMERAL mode: the value is a one-time, short-lived token (an OAuth verification code, a 2FA code, a
   * sudo password) that must be handed to a process the brain has running in the sandbox and **never**
   * persisted. When set, the `provide-secret` endpoint does NOT write the encrypted store / grant / rehydrate
   * — it pipes the value straight into {@link deliver_to} inside the live container over exec stdin, then
   * discards it. Nothing about the value survives the delivery.
   */
  ephemeral?: boolean;
  /**
   * Ephemeral-only: the ABSOLUTE in-container path the operator's value is delivered to (a FIFO the brain
   * created and wired its waiting process to read — e.g. `/tmp/atlas-login-in`). Operational, not a secret.
   */
  deliver_to?: string;
  /**
   * MCP-TARGET mode: the value is a credential for a user-defined MCP server (a header/env slot), not a
   * workspace secret. When set, `provide-secret` writes the value into `mcp_servers.secrets_enc` (via
   * `McpServerStore.setSecret`) instead of the worktree store, and does NOT grant/rehydrate (MCP secrets are
   * resolved per-turn by `McpResolver`). `path` is absent for an MCP target. The scope is NOT carried here —
   * it is re-derived from the thread's repo at commit (never trust a card-supplied scope). Value-free like
   * every other lane.
   */
  mcp?: {
    /** The MCP server `name` the secret belongs to (repo-scoped, on this thread's repo). */
    server: string;
    /** Which slot the value fills — a request header (remote) or an env var (stdio). */
    slot: 'header' | 'env';
    /** The header/env key name (e.g. `Authorization`, `GITHUB_TOKEN`). */
    key: string;
  };
  /** Why the secret is needed (the brain's one-line rationale). */
  description: string;
  /**
   * Optional URL to surface as a clickable link ABOVE the input — used for a headless login flow
   * (`gcloud auth login --no-browser` prints an auth URL; the operator opens it, completes the browser
   * step, and pastes the resulting code back into the field). Absent for an ordinary secret value.
   */
  url?: string;
  /**
   * ISO-8601 time the operator submitted the value (which went straight to the encrypted store + a grant).
   * Its presence is the durable "provided" state; the VALUE is never stored here. The lifecycle is
   * `requested → provided (provided_at) → delivered (delivered_at)`.
   */
  provided_at?: string;
  /**
   * ISO-8601 time the masked confirmation was DELIVERED to the brain (a delivery turn actually ran). The
   * gate (`threads.awaiting_secret_id`) clears only then, so the boot sweep can re-deliver any
   * `provided_at != null && delivered_at == null` card a crash left stranded (at-least-once).
   */
  delivered_at?: string;
  /**
   * ISO-8601 time a durable/mcp request was WITHDRAWN — either by the brain via `withdraw_secret_request`
   * (no longer needed / wrong target) or by the provide endpoint stamping a terminal failure (an MCP
   * OAuth refusal, a vanished MCP server row) in place of the old single-slot clear. Terminal + mutually
   * exclusive with `provided_at`. Its presence greys the card out and makes a racing provide a no-op. Not
   * used by the EPHEMERAL lane, which keeps its single-slot `awaiting_secret_id` pointer instead.
   */
  withdrawnAt?: string;
  /** The optional one-line rationale for the withdrawal (shown on the greyed card). */
  withdrawnReason?: string;
}

/** Build a `WebSecretInputCard` from the brain's `request_secret` args. */
export function webSecretInputCard(input: {
  jobId: string;
  requestId: string;
  name: string;
  path?: string;
  description: string;
  url?: string;
  ephemeral?: boolean;
  deliver_to?: string;
  mcp?: { server: string; slot: 'header' | 'env'; key: string };
}): WebSecretInputCard {
  return {
    type: 'secret_input_card',
    jobId: input.jobId,
    requestId: input.requestId,
    name: input.name,
    ...(input.path ? { path: input.path } : {}),
    description: input.description,
    ...(input.url ? { url: input.url } : {}),
    ...(input.ephemeral ? { ephemeral: true } : {}),
    ...(input.deliver_to ? { deliver_to: input.deliver_to } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
  };
}
