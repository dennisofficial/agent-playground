import type { SessionEngine } from '../../_shared/domain';
import type { EngineAuth, EngineHomeKey, GitAuth } from '../../_shared/engine';

export type FindingSeverity = 'low' | 'medium' | 'high';

export interface ReviewFinding {
  lens: string;
  severity: FindingSeverity;
  file: string | null;
  title: string;
  detail: string;
}

export interface ReviewLens {
  id: string;
  label: string;
  focus: string;
  scope?: 'diff' | 'holistic' | 'framework';
}

export interface AutoFixCommit {
  sha: string;
  message: string;
}

export interface AutoFixSummary {
  mode: 'thread' | 'pull_request';
  lensesRun: string[];
  findings: ReviewFinding[];
  fixesAttempted: boolean;
  fixReport: string;
  commits: AutoFixCommit[];
  clean: boolean;
}

export interface AutoFixOptions {
  lenses?: ReviewLens[];
  concurrency?: number;
  applyFixes?: boolean;
  fixMinSeverity?: FindingSeverity;
  engine?: SessionEngine;
  model?: string;
  auth?: EngineAuth;
  onLensStatus?: (lensId: string, status: LensStatus, findings?: number) => void;
}

export type LensStatus = 'running' | 'passed' | 'failed' | 'skipped';

export interface AutoFixContext {
  worktreePath: string;
  sandboxKey: EngineHomeKey;
  diff?: string;
  changedFiles?: string[];
  gitRange?: string;
  intent: string;
  label?: string;
  containerId?: string;
  execUser?: string;
  gitAuth?: GitAuth;

  jobId?: string;
  channel?: string;
  autofixId?: string;
  threadId?: string;
  scope?: 'thread' | 'pr';

  orgId?: string;
  repoId?: string;
  frameworkBodies?: { name: string; body: string }[];
}
