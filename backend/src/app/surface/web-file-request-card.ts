/**
 * Web FILE-REQUEST card payload — the secure request the repo-onboarding brain poses via the
 * `request_file` tool when it needs the operator to UPLOAD a file whose contents can't be typed (a
 * service-account JSON, a keystore/`.pem`, a gitignored `.env.keys`). The web client renders a file
 * picker; the operator's file is read as text and POSTed to `…/jobs/:jobId/provide-file`, which writes
 * the contents straight to the encrypted `WorktreeSecretStore` (as a file-valued secret) and creates the
 * owner grant that renders it to `path` in future build threads. The contents are therefore NEVER part
 * of this card, the transcript, or any brain tool I/O — the card holds only the request metadata +
 * lifecycle timestamps, and once provided the client renders a compact "✓ path uploaded" state.
 *
 * Pure — no I/O, no NestJS. Mirrors `web-secret-input-card.ts` but the value arrives as an UPLOAD, and
 * the gate is PER-CARD (like `ask_question`) — several file requests can be open at once, so there is no
 * single-slot thread pointer (no migration; state lives entirely on this card in the `messages` jsonb).
 */

/** A rendered web file-request card — posted to the surface transcript + persisted as a durable card row. */
export interface WebFileRequestCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'file_request_card';
  jobId: string;
  /** Stable key for this request (the card row's `ts`); the provide POST echoes it back. */
  requestId: string;
  /** The worktree-relative destination the uploaded file will be rendered to in build threads (e.g. `.env.keys`). */
  path: string;
  /** Why the file is needed (the brain's one-line rationale). */
  description: string;
  /**
   * The operator-chosen filename at upload time (metadata only — display + provenance; NEVER the contents).
   * Present once provided.
   */
  filename?: string;
  /**
   * ISO-8601 time the operator uploaded the file (its contents went straight to the encrypted store + a
   * grant). Its presence is the durable "provided" state; the CONTENTS are never stored here. Lifecycle:
   * `requested → (provided (provided_at) → delivered (delivered_at) | withdrawn (withdrawnAt))`.
   */
  provided_at?: string;
  /**
   * ISO-8601 time the masked confirmation was DELIVERED to the brain (a delivery turn actually ran). The
   * boot sweep re-delivers any `provided_at != null && delivered_at == null` card a crash left stranded
   * (at-least-once); the per-card gate needs no thread pointer.
   */
  delivered_at?: string;
  /**
   * ISO-8601 time the brain WITHDREW this request via `withdraw_file_request` (wrong path / no longer
   * needed). Terminal + mutually exclusive with `provided_at` (the withdraw only fires while the request is
   * still open — see `BrainStore.withdrawFileRequest`). Its presence greys the card out (no file picker) and
   * makes a racing upload a no-op. The CONTENTS were never involved.
   */
  withdrawnAt?: string;
  /** The brain's optional one-line rationale for the withdrawal (shown on the greyed card). */
  withdrawnReason?: string;
}

/** Build a `WebFileRequestCard` from the brain's `request_file` args. */
export function webFileRequestCard(input: {
  jobId: string;
  requestId: string;
  path: string;
  description: string;
}): WebFileRequestCard {
  return {
    type: 'file_request_card',
    jobId: input.jobId,
    requestId: input.requestId,
    path: input.path,
    description: input.description,
  };
}
