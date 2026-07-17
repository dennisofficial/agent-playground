export interface WebConventionProposalCard {
  type: 'convention_proposal_card';
  jobId: string;
  requestId: string;
  repoId: string;
  slug: string;
  profileName: string;
  rationale: string;
  approved_at?: string;
  dismissed_at?: string;
}

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
