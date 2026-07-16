/**
 * prompt-kit / harness — the `chunkKey` registry.
 *
 * Every seeded/reminder/rotation turn chunk the brain or driver persists carries a stable, content- or
 * identity-derived `chunkKey` so a re-delivery (a crash-recovery boot sweep, a re-driven turn) inserts the
 * SAME row instead of duplicating it in the visible transcript. This module is the single place those key
 * strings are minted, so the format is defined once and every call site stays byte-identical to what the
 * (pre-existing, durable) rows already on disk expect. Pure, zero-dep.
 */

/** A pending secret confirmation the brain re-delivers to the sandbox. */
function secret(
  jobId: string,
  name: string,
  opts?: { fail?: boolean },
): string {
  const base = `seed:secret:${jobId}:${name}`;
  return opts?.fail ? `${base}:fail` : base;
}

/** An MCP-server-scoped secret/credential confirmation. */
function mcpSecret(
  jobId: string,
  server: string,
  key: string,
  variant?: 'oauth' | 'fail',
): string {
  const base = `seed:secret:${jobId}:mcp:${server}:${key}`;
  return variant ? `${base}:${variant}` : base;
}

/** A pending uploaded-file confirmation. */
function file(jobId: string, path: string): string {
  return `seed:file:${jobId}:${path}`;
}

/** An answered `ask_question` re-delivery. */
function qa(jobId: string, questionId: string): string {
  return `seed:qa:${jobId}:${questionId}`;
}

/** A combined `answer-batch` delivery — one stable pill for the whole batch, keyed by its member card ids. */
function batch(jobId: string, ids: string[]): string {
  return `seed:batch:${jobId}:${ids.join(',')}`;
}

/** A synthetic retry-continuation seed, keyed by wall-clock so repeated retries don't collide. */
function retry(jobId: string, ts: number): string {
  return `seed:retry:${jobId}:${ts}`;
}

/** The single live-preview seed for a job. */
function preview(jobId: string): string {
  return `seed:preview:${jobId}`;
}

/** The single post_build ship-review-gate seed for a job. */
function gate(jobId: string): string {
  return `seed:gate:${jobId}`;
}

/** The once-per-approval plan-approved base-check seed, keyed by decision record id. */
function planApproved(decisionRecordId: string): string {
  return `seed:plan-approved:${decisionRecordId}`;
}

/** An MCP server-approval request. */
function mcpApprove(jobId: string, requestId: string): string {
  return `seed:mcp-approve:${jobId}:${requestId}`;
}

/** An MCP server-removal request. */
function mcpRemove(jobId: string, requestId: string): string {
  return `seed:mcp-remove:${jobId}:${requestId}`;
}

/** A convention-profile adoption approval request. */
function convApprove(jobId: string, requestId: string): string {
  return `seed:conv-approve:${jobId}:${requestId}`;
}

/** A convention-profile EDIT approval request. */
function convEditApprove(jobId: string, requestId: string): string {
  return `seed:conv-edit-approve:${jobId}:${requestId}`;
}

/** A skill-install approval request. */
function skillApprove(jobId: string, requestId: string): string {
  return `seed:skill-approve:${jobId}:${requestId}`;
}

/** A skill-file EDIT approval request. */
function skillEditApprove(jobId: string, requestId: string): string {
  return `seed:skill-edit-approve:${jobId}:${requestId}`;
}

/** A Leg-rotation SOFT/REMINDER pressure nudge, keyed per anchor/Leg/phase/reminder ordinal. */
function rotNudge(
  anchorId: string,
  legOrdinal: number,
  phase: string,
  reminderIndex: number,
): string {
  return `rot-nudge:${anchorId}:leg${legOrdinal}:${phase}${reminderIndex}`;
}

/** The closing Leg's self-authored handoff, recorded on rotation. */
function rotHandoff(anchorId: string, fromLeg: number): string {
  return `rot-handoff:${anchorId}:leg${fromLeg}`;
}

/** The fresh Leg's continuation seed, recorded on rotation. */
function rotSeed(anchorId: string, toLeg: number): string {
  return `rot-seed:${anchorId}:leg${toLeg}`;
}

/** The chunkKey registry — every call site mints its key through here, never a hand-rolled template. */
export const chunkKey = {
  secret,
  mcpSecret,
  file,
  qa,
  batch,
  retry,
  preview,
  gate,
  planApproved,
  mcpApprove,
  mcpRemove,
  convApprove,
  convEditApprove,
  skillApprove,
  skillEditApprove,
  rotNudge,
  rotHandoff,
  rotSeed,
};
