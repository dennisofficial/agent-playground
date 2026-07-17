import type { SessionEngine } from '@shared/domain';
import type { ReasoningEffort } from '@shared/engine';
import { Agent } from '@shared/prompt-kit/system';
import type { ThreadKind as LaneKind, ThreadInput } from '../../surface/thread-registry';

export type ThreadRole =
  | 'planning' // the job brain session (operator conversation). Render/identity-only — driver never executes it.
  | 'plan_review' // the synchronous Codex plan review. Render/identity-only — runtime stays in the brain.
  | 'builder' // a build lane's own execute session. Top-level executable; parents its review children.
  | 'review_agent' // one post-build review lens over a builder's diff. Driven as a CHILD of the builder.
  | 'review_fix' // the fix pass that applies a builder's deduped lens findings. Driven as a CHILD.
  | 'master_review' // the ship-time Codex whole-diff review-&-fix. Top-level executable, runs last.
  | 'post_build' // the ship-gate thread-group thread: build summary, preview proposal, and amend loop.
  | 'ci'; // the post-ship PR-lifecycle thread-group thread: PR creation, CI handling, review comments, conflicts.

export type ThreadExecution = 'top-level' | 'child' | 'render-only';

export interface ThreadChildSpec {
  kind: ThreadRole;
  brief: string;
  config: Record<string, unknown>;
}

export interface ThreadKindParent {
  id: string;
  type?: string;
  config: Record<string, unknown>;
}

export interface ThreadKindSpec {
  kind: ThreadRole;
  agent: Agent;
  engine: SessionEngine;
  mode: 'execute' | 'review' | 'conversational';
  execution: ThreadExecution;
  reasoningEffort?: ReasoningEffort;
  laneKind: LaneKind;
  inputPolicy: ThreadInput;
  operatorInput: boolean;
  taskScope: 'thread' | 'main' | 'none';
  runner: 'execute-turn' | 'session-backed';
  children?: (parent: ThreadKindParent) => ThreadChildSpec[];
}
