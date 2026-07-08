/**
 * Web CONVENTION-PROPOSAL card payload — the owner-approvable recommendation the repo-onboarding brain poses
 * via `propose_convention_profile` once it has mapped the repo's stack and matched it against the org's
 * reusable house-style profiles. The brain never attaches a profile directly (that's an owner-only action);
 * it POSTs this card naming the matched profile, and the owner approves it at the owner-gated
 * `…/jobs/:jobId/convention-proposals/:requestId/approve` endpoint, which sets `repos.convention_profile_slug`
 * to the proposed slug (FORCED to the thread's repo — never trusted from the card).
 *
 * Pure — no I/O, no NestJS. Mirrors `web-mcp-proposal-card.ts`. Per-card lifecycle: `proposed → approved
 * (approved_at)`. A "no match" outcome posts NO card (the default is already unset) — only a concrete
 * profile match is approvable.
 */

/** A rendered convention-proposal card — posted to the surface transcript + persisted as a durable card row. */
export interface WebConventionProposalCard {
  /** Discriminant — the web client checks `type` to decide which component to render. */
  type: 'convention_proposal_card';
  jobId: string;
  /** Stable key for this proposal (the card row's `ts`); the approve POST echoes it back. */
  requestId: string;
  /** The repo the profile will be attached to (display only — the commit re-derives scope from the thread). */
  repoId: string;
  /** The proposed profile's stable slug (what gets written to `repos.convention_profile_slug`). */
  slug: string;
  /** The proposed profile's display name (shown to the operator). */
  profileName: string;
  /** The brain's one-line rationale for why this profile matches the repo's stack. */
  rationale: string;
  /**
   * ISO-8601 time the OWNER approved and the profile was attached. Its presence is the terminal "approved"
   * state; the web client then renders a compact "✓ attached" state.
   */
  approved_at?: string;
  /** ISO-8601 time the owner dismissed the proposal without approving (optional — frontend affordance). */
  dismissed_at?: string;
}

/** Build a `WebConventionProposalCard` from the brain's validated `propose_convention_profile` args. */
export function webConventionProposalCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  slug: string;
  profileName: string;
  rationale: string;
}): WebConventionProposalCard {
  return {
    type: 'convention_proposal_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    slug: input.slug,
    profileName: input.profileName,
    rationale: input.rationale,
  };
}
