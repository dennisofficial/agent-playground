
import type { SessionEngine } from '@workspace/agent-engine';

export type { SessionEngine } from '@workspace/agent-engine';

export type SessionMode = 'plan' | 'execute' | 'review' | 'investigate';

export interface SessionRef {
  id: string;
  jobId: string;
  stepId: string | null;
  engine: SessionEngine;
  mode: SessionMode;
  branch: string;
  worktreePath: string;
}
