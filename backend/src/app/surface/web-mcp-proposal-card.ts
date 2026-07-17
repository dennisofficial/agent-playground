import type { McpSurface, StoredMcpOAuthConfig } from '../persistence/entities';

export interface McpProposalServer {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  authKind?: 'static' | 'oauth';
  oauth?: StoredMcpOAuthConfig;
  url?: string;
  command?: string;
  args?: string[];
  headers?: { name: string; secret?: boolean; value?: string }[];
  env?: { name: string; secret?: boolean; value?: string }[];
  surfaces?: McpSurface[];
  reason?: string;
}

export interface WebMcpProposalCard {
  type: 'mcp_proposal_card';
  jobId: string;
  requestId: string;
  repoId: string;
  scope?: 'org' | 'repo';
  mode?: 'register' | 'remove';
  removeNames?: string[];
  servers: McpProposalServer[];
  approved_at?: string;
  committed?: string[];
  dismissed_at?: string;
}

export function webMcpProposalCard(input: {
  jobId: string;
  requestId: string;
  repoId: string;
  scope?: 'org' | 'repo';
  mode?: 'register' | 'remove';
  removeNames?: string[];
  servers: McpProposalServer[];
}): WebMcpProposalCard {
  return {
    type: 'mcp_proposal_card',
    jobId: input.jobId,
    requestId: input.requestId,
    repoId: input.repoId,
    scope: input.scope ?? 'repo',
    mode: input.mode ?? 'register',
    ...(input.removeNames && input.removeNames.length ? { removeNames: input.removeNames } : {}),
    servers: input.servers,
  };
}
