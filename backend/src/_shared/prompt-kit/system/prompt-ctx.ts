import type { AutoApproveMode } from '@workspace/shared';
import type { JobKind } from '../../domain';

export interface PromptCtx {
  jobKind?: JobKind | null;
  threadType?: string | null;
  previewInstructions?: string | null;
  turnPhase?: 'batch' | 'commit';
  job?: {
    repoName?: string;
    title?: string;
    branch?: string;
    baseBranch?: string;
    isAtlasRepo?: boolean;
  } | null;
  settings?: {
    userOrgInstructions?: string;
    repoConventions?: { name: string; body: string } | null;
    workspaceProfile?: string | null;
    autoApproveMode?: AutoApproveMode;
    autoMerge?: boolean;
  };
}
