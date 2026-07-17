
export interface WebSkillProposalCard {
  type: 'skill_proposal_card';
  jobId: string;
  requestId: string;
  repoId: string;
  scope: 'org' | 'repo';
  name: string;
  description: string;
  surfaces: ('brain' | 'build' | 'review')[];
  mode: 'create' | 'install' | 'remove';
  rationale: string;

  stagingPath?: string;
  preview?: { skillMd: string; files: string[] };

  sourceUrl?: string;
  sourceRef?: string;
  sourceSubpath?: string;
  installPreview?: {
    rows: { name: string; description: string; overwrites: boolean }[];
  };

  priorBody?: string;

  approved_at?: string;
  dismissed_at?: string;
}

export function webSkillProposalCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  scope: 'org' | 'repo';
  name: string;
  description: string;
  surfaces: ('brain' | 'build' | 'review')[];
  mode: 'create' | 'install' | 'remove';
  rationale: string;
  stagingPath?: string;
  preview?: { skillMd: string; files: string[] };
  sourceUrl?: string;
  sourceRef?: string;
  sourceSubpath?: string;
  installPreview?: {
    rows: { name: string; description: string; overwrites: boolean }[];
  };
  priorBody?: string;
}): WebSkillProposalCard {
  return {
    type: 'skill_proposal_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    scope: input.scope,
    name: input.name,
    description: input.description,
    surfaces: input.surfaces,
    mode: input.mode,
    rationale: input.rationale,
    ...(input.stagingPath !== undefined ? { stagingPath: input.stagingPath } : {}),
    ...(input.preview !== undefined ? { preview: input.preview } : {}),
    ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
    ...(input.sourceSubpath !== undefined ? { sourceSubpath: input.sourceSubpath } : {}),
    ...(input.installPreview !== undefined ? { installPreview: input.installPreview } : {}),
    ...(input.priorBody !== undefined ? { priorBody: input.priorBody } : {}),
  };
}
