
function secret(jobId: string, name: string, opts?: { fail?: boolean }): string {
  const base = `seed:secret:${jobId}:${name}`;
  return opts?.fail ? `${base}:fail` : base;
}

function mcpSecret(jobId: string, server: string, key: string, variant?: 'oauth' | 'fail'): string {
  const base = `seed:secret:${jobId}:mcp:${server}:${key}`;
  return variant ? `${base}:${variant}` : base;
}

function file(jobId: string, path: string): string {
  return `seed:file:${jobId}:${path}`;
}

function qa(jobId: string, questionId: string): string {
  return `seed:qa:${jobId}:${questionId}`;
}

function batch(jobId: string, ids: string[]): string {
  return `seed:batch:${jobId}:${ids.join(',')}`;
}

function retry(jobId: string, ts: number): string {
  return `seed:retry:${jobId}:${ts}`;
}

function sessionLimit(jobId: string, ts: number): string {
  return `seed:sessionlimit:${jobId}:${ts}`;
}

function ship(jobId: string): string {
  return `seed:ship:${jobId}`;
}

function workOwed(reviewId: string): string {
  return `seed:work-owed:${reviewId}`;
}

function amendApproved(jobId: string): string {
  return `seed:amend-approved:${jobId}`;
}

function requestChanges(decisionRecordId: string): string {
  return `seed:request-changes:${decisionRecordId}`;
}

function unblock(jobId: string): string {
  return `seed:unblock:${jobId}`;
}

function bornBlockedSeed(jobId: string): string {
  return `seed:born-blocked:${jobId}`;
}

function blockNote(jobId: string): string {
  return `seed:blocked:${jobId}`;
}

function preview(jobId: string): string {
  return `seed:preview:${jobId}`;
}

function gate(jobId: string): string {
  return `seed:gate:${jobId}`;
}

function planApproved(decisionRecordId: string): string {
  return `seed:plan-approved:${decisionRecordId}`;
}

function mcpApprove(jobId: string, requestId: string): string {
  return `seed:mcp-approve:${jobId}:${requestId}`;
}

function mcpRemove(jobId: string, requestId: string): string {
  return `seed:mcp-remove:${jobId}:${requestId}`;
}

function convApprove(jobId: string, requestId: string): string {
  return `seed:conv-approve:${jobId}:${requestId}`;
}

function convEditApprove(jobId: string, requestId: string): string {
  return `seed:conv-edit-approve:${jobId}:${requestId}`;
}

function skillApprove(jobId: string, requestId: string): string {
  return `seed:skill-approve:${jobId}:${requestId}`;
}

function skillEditApprove(jobId: string, requestId: string): string {
  return `seed:skill-edit-approve:${jobId}:${requestId}`;
}

function rotNudge(
  anchorId: string,
  legOrdinal: number,
  phase: string,
  reminderIndex: number,
): string {
  return `rot-nudge:${anchorId}:leg${legOrdinal}:${phase}${reminderIndex}`;
}

function rotHandoff(anchorId: string, fromLeg: number): string {
  return `rot-handoff:${anchorId}:leg${fromLeg}`;
}

function rotSeed(anchorId: string, toLeg: number): string {
  return `rot-seed:${anchorId}:leg${toLeg}`;
}

export const chunkKey = {
  secret,
  mcpSecret,
  file,
  qa,
  batch,
  retry,
  sessionLimit,
  ship,
  workOwed,
  amendApproved,
  requestChanges,
  unblock,
  bornBlockedSeed,
  blockNote,
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
