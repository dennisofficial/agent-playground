export interface WebSkillEditAccessCard {
  type: 'skill_edit_access_card';
  jobId: string;
  requestId: string;
  repoId: string;
  scope: 'org' | 'repo';
  name: string;
  provenance: 'git' | 'custom' | 'managed';
  sourceUrl?: string | null;
  sourceRef?: string | null;
  rationale: string;
  approved_at?: string;
  forkedTo?: string;
  dismissed_at?: string;
}

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
