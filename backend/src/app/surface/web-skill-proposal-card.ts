/**
 * Web SKILL-PROPOSAL card payload — the owner-approvable SKILL the brain poses via `propose_skill` (during
 * onboarding's bulk pass OR incrementally on any later job) when it notices a reusable `SKILL.md` would help
 * builds on this repo/org. The brain never writes a skill directly — a skill shapes how every future build
 * behaves, so it POSTs this card describing the skill, and the OWNER approves it at
 * `…/jobs/:jobId/skill-proposals/:requestId/approve`, which writes it via `WorkspaceSkillStore.write`.
 *
 * Mirrors {@link WebConventionEditProposalCard}. Pure — no I/O, no NestJS. Per-card lifecycle: `proposed → approved`.
 */

export interface WebSkillProposalCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'skill_proposal_card';
  jobId: string;
  /** Stable key for this proposal (the card row's `ts`); the approve POST echoes it back. */
  requestId: string;
  /** The repo whose build raised the proposal (also the write target when `scope==='repo'`). */
  repoId: string;
  /** `'org'` = every repo in the org; `'repo'` = this repo only. Drives the write scope on approval. */
  scope: 'org' | 'repo';
  /** The skill name (the on-disk skill dir; unique within the (org, scope) tier). */
  name: string;
  /** The SKILL.md frontmatter `description` — the trigger blurb ("Use when …"). */
  description: string;
  /** The proposed SKILL.md markdown body. */
  body: string;
  /** Turn surfaces the skill is active on (brain | build | review). */
  surfaces: ('brain' | 'build' | 'review')[];
  /**
   * `create` a new skill, `update` an existing one's content, or `remove` (delete) an existing one. On
   * `remove`, `description`/`body` are empty and `priorBody` carries what will be deleted (for the owner).
   */
  mode: 'create' | 'update' | 'remove';
  /** On `update`, the skill's CURRENT body — so the owner can see what the change replaces. */
  priorBody?: string;
  /** The brain's rationale for why the skill helps (shown to the owner). */
  rationale: string;
  /** ISO-8601 time the OWNER approved and the skill was written. Terminal "approved" state. */
  approved_at?: string;
  /** ISO-8601 time the owner dismissed the proposal without approving (optional — frontend affordance). */
  dismissed_at?: string;
}

/** Build a `WebSkillProposalCard` from the brain's validated `propose_skill` args. */
export function webSkillProposalCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  scope: 'org' | 'repo';
  name: string;
  description: string;
  body: string;
  surfaces: ('brain' | 'build' | 'review')[];
  mode: 'create' | 'update' | 'remove';
  priorBody?: string;
  rationale: string;
}): WebSkillProposalCard {
  return {
    type: 'skill_proposal_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    scope: input.scope,
    name: input.name,
    description: input.description,
    body: input.body,
    surfaces: input.surfaces,
    mode: input.mode,
    ...(input.priorBody !== undefined ? { priorBody: input.priorBody } : {}),
    rationale: input.rationale,
  };
}
