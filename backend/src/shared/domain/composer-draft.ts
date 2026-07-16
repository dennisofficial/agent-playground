/**
 * The composer draft payload — one draft per (job, user), server-side so an operator's in-progress
 * message (text, staged question/file/secret answers, queued review comments) survives a tab close or
 * device switch instead of living only in browser state. See `ComposerDraftEntity`.
 */

/** A review comment queued in the composer (mirrors the client-side `ReviewComment` in
 *  `web/src/features/job-workspace/review-comments.tsx` — kept in sync by hand, no shared package today). */
export type ReviewComment = {
  id: string;
  file: CommentTarget;
  quote: string;
  note: string;
  lines?: DiffLineAnchor;
};

/** Which open node a queued review comment is attached to (mirrors `CommentTarget`). */
export type CommentTarget = {
  node: string;
  label: string;
};

/** The stored anchor for a diff-gutter line comment (mirrors `DiffLineAnchor`). */
export type DiffLineAnchor = {
  path: string;
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
  fragment: string;
};

/** One staged answer to an open card, held in the draft until the composer sends it. The `secret` variant
 *  persists `valueEnc` (an encrypted blob) — the WIRE shape a later thread's GET/PUT DTO exposes to the
 *  owner's own device instead uses a cleartext `value`; that encode/decode is a service-layer mapping
 *  concern, not modeled in this shared type. */
export type DraftStagedAnswer =
  | { kind: 'question'; cardId: string; label: string; answer: string }
  | {
      kind: 'file';
      cardId: string;
      label: string;
      filename: string;
      content: string;
    }
  | { kind: 'secret'; cardId: string; label: string; valueEnc: string };

/** The full draft payload persisted per (job, user). */
export type DraftPayload = {
  text: string;
  stagedAnswers: DraftStagedAnswer[];
  comments: ReviewComment[];
};
