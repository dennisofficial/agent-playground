/**
 * Web CONVENTION-EDIT-PROPOSAL card payload — the owner-approvable house-style CHANGE the BUILD brain poses
 * via `propose_convention_profile_change` when it notices, mid-work, that the reusable org-level house style
 * itself should evolve (not just this repo's code). The brain never writes a profile directly — a house-style
 * change is cross-cutting (it affects every repo/job in the org), so it POSTs this card describing the new
 * body, and the OWNER approves it at `…/jobs/:jobId/convention-edit-proposals/:requestId/approve`, which
 * upserts the profile via `ConventionProfileResolver.upsertProfile`.
 *
 * Distinct from {@link WebConventionProposalCard} (which ATTACHES an existing profile to a repo): this one
 * proposes the profile's CONTENT. Pure — no I/O, no NestJS. Per-card lifecycle: `proposed → approved`.
 */

export interface WebConventionEditProposalCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'convention_edit_proposal_card';
  jobId: string;
  /** Stable key for this proposal (the card row's `ts`); the approve POST echoes it back. */
  requestId: string;
  /** The repo whose build raised the proposal (context only — the profile itself is org-level). */
  repoId: string;
  /** The profile slug being created or edited. */
  slug: string;
  /** The proposed display name. */
  name: string;
  /** The proposed house-style body (markdown) — what the profile becomes on approval. */
  body: string;
  /** The proposed detect-hint (or null). */
  detectHint: string | null;
  /** Whether this creates a brand-new profile or edits an existing one (drives the owner's framing + diff). */
  mode: 'create' | 'update';
  /** On `update`, the profile's CURRENT body — so the owner can see what the change replaces. */
  priorBody?: string;
  /** The brain's rationale for why the house style should change (shown to the owner). */
  rationale: string;
  /** ISO-8601 time the OWNER approved and the profile was upserted. Terminal "approved" state. */
  approved_at?: string;
  /** ISO-8601 time the owner dismissed the proposal without approving (optional — frontend affordance). */
  dismissed_at?: string;
}

/** Build a `WebConventionEditProposalCard` from the brain's validated `propose_convention_profile_change` args. */
export function webConventionEditProposalCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  slug: string;
  name: string;
  body: string;
  detectHint: string | null;
  mode: 'create' | 'update';
  priorBody?: string;
  rationale: string;
}): WebConventionEditProposalCard {
  return {
    type: 'convention_edit_proposal_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    slug: input.slug,
    name: input.name,
    body: input.body,
    detectHint: input.detectHint,
    mode: input.mode,
    ...(input.priorBody !== undefined ? { priorBody: input.priorBody } : {}),
    rationale: input.rationale,
  };
}
