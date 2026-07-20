export interface WebConventionEditProposalCard {
  type: 'convention_edit_proposal_card';
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
  approved_at?: string;
  dismissed_at?: string;
}

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
