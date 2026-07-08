/**
 * Web SKILL-EDIT-ACCESS card payload — the owner-approvable card a brain `request_skill_edit_access` posts
 * when it wants live `Edit`/`Write` access to an already-registered skill for the REST of this session
 * (skills are read-only by default — see `makeCanUseTool`'s skill guard in `engine-core.ts`). Unlike
 * `propose_skill` (which replaces a whole `SKILL.md` body in one owner-reviewed shot), this grants
 * GRANULAR, iterative editing — the brain then uses `Edit`/`Write` directly on the skill's files.
 *
 * A `git`-provenance skill can't be edited in place (it would drift from its source and never update
 * again): approving THIS card forks it to a new `custom` skill first (`forkedTo`/`forkedFrom` on the
 * approved card), and the grant applies to the FORK — the original stays clean and updatable.
 *
 * Mirrors {@link WebSkillProposalCard}. Pure — no I/O, no NestJS. Per-card lifecycle: `requested → approved`.
 */

export interface WebSkillEditAccessCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'skill_edit_access_card';
  jobId: string;
  /** Stable key for this request (the card row's `ts`); the approve POST echoes it back. */
  requestId: string;
  /** The repo whose job raised the request (also the scope's repo id when `scope==='repo'`). */
  repoId: string;
  /** `'org'` = the skill is org-wide; `'repo'` = scoped to this repo. Mirrors the skill's own registry scope. */
  scope: 'org' | 'repo';
  /** The skill name as it exists TODAY (before any fork). */
  name: string;
  /** The skill's provenance at request time — drives the fork-to-custom warning below. */
  provenance: 'git' | 'custom' | 'managed';
  /** Set when `provenance==='git'` — shown as the fork warning ("editing forks it… no longer updates"). */
  sourceUrl?: string | null;
  sourceRef?: string | null;
  /** The brain's stated reason for wanting to edit (shown to the owner). */
  rationale: string;
  /** ISO-8601 time the OWNER approved. Terminal "approved" state. */
  approved_at?: string;
  /** Set on approval when the skill was forked — the new custom skill's name (the grant target). Absent
   *  when no fork was needed (`provenance!=='git'` — the grant just applies to `name`). */
  forkedTo?: string;
  /** ISO-8601 time the owner dismissed the request without approving (optional — frontend affordance). */
  dismissed_at?: string;
}

/** Build a `WebSkillEditAccessCard` from the brain's validated `request_skill_edit_access` args. */
export function webSkillEditAccessCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  scope: 'org' | 'repo';
  name: string;
  provenance: 'git' | 'custom' | 'managed';
  sourceUrl?: string | null;
  sourceRef?: string | null;
  rationale: string;
}): WebSkillEditAccessCard {
  return {
    type: 'skill_edit_access_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    scope: input.scope,
    name: input.name,
    provenance: input.provenance,
    ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
    rationale: input.rationale,
  };
}
