/**
 * Web SECRET-INPUT card payload — the secure request the repo-onboarding brain poses via the
 * `request_secret` tool when it needs an env-file secret value (e.g. `DATABASE_URL`). The web client
 * renders a masked password field + submit; the operator's value is POSTed to
 * `…/threads/:threadId/provide-secret`, which writes it straight to the encrypted `WorktreeSecretStore`
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
  threadId: string;
  /** Stable key for this request (the card row's `ts`); the provide POST echoes it back. */
  requestId: string;
  /** The secret's name (→ `OrgWorktreeSecretEntity.name`); shown to the operator, never the value. */
  name: string;
  /** The worktree-relative destination the secret will be rendered to in build threads (e.g. `.env`). */
  path: string;
  /** Why the secret is needed (the brain's one-line rationale). */
  description: string;
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
}

/** Build a `WebSecretInputCard` from the brain's `request_secret` args. */
export function webSecretInputCard(input: {
  threadId: string;
  requestId: string;
  name: string;
  path: string;
  description: string;
}): WebSecretInputCard {
  return {
    type: 'secret_input_card',
    threadId: input.threadId,
    requestId: input.requestId,
    name: input.name,
    path: input.path,
    description: input.description,
  };
}
