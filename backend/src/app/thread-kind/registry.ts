import type { SessionEngine } from '@shared/domain';
import type { ReasoningEffort } from '@shared/engine';
import { Agent, renderAgentPrompt } from '@shared/prompt-kit/system';
import { THREAD_REGISTRY } from '../surface/thread-registry';
import type { ThreadKindSpec, ThreadRole } from './__tests__/spec';

const CLAUDE_BRAIN_MODEL = 'opus';
const CLAUDE_WORKER_MODEL = 'claude-sonnet-5';

const POST_REVIEW_MIN_SEVERITY = 'medium';

export const THREAD_KIND_SPECS: readonly ThreadKindSpec[] = [
  {
    kind: 'planning',
    agent: Agent.PLANNING,
    engine: 'claude',
    mode: 'conversational',
    execution: 'render-only',
    reasoningEffort: 'high',
    laneKind: 'main',
    inputPolicy: 'operator',
    operatorInput: true,
    taskScope: 'main',
    runner: 'session-backed',
  },
  {
    kind: 'plan_review',
    agent: Agent.META_PLAN_REVIEW,
    engine: 'codex',
    mode: 'review',
    reasoningEffort: 'xhigh',
    execution: 'render-only',
    laneKind: 'codex-review',
    inputPolicy: 'agent',
    operatorInput: false,
    taskScope: 'none',
    runner: 'session-backed',
  },
  {
    kind: 'builder',
    agent: Agent.WORKER,
    engine: 'claude',
    mode: 'execute',
    execution: 'top-level',
    reasoningEffort: 'high',
    laneKind: 'builder',
    inputPolicy: 'none',
    operatorInput: true,
    taskScope: 'thread',
    runner: 'execute-turn',
    children: () => [
      {
        kind: 'review_fix' as ThreadRole,
        brief: 'Post-review fixes',
        config: { minSeverity: POST_REVIEW_MIN_SEVERITY },
      },
    ],
  },
  {
    kind: 'review_agent',
    agent: Agent.AUTOFIX_REVIEW,
    engine: 'claude',
    mode: 'review',
    execution: 'child',
    reasoningEffort: 'high',
    laneKind: 'autofix-lens',
    inputPolicy: 'none',
    operatorInput: false,
    taskScope: 'none',
    runner: 'execute-turn',
  },
  {
    kind: 'review_fix',
    agent: Agent.AUTOFIX_FIX,
    engine: 'claude',
    mode: 'execute',
    execution: 'child',
    reasoningEffort: 'high',
    laneKind: 'autofix-fix',
    inputPolicy: 'none',
    operatorInput: false,
    taskScope: 'none',
    runner: 'execute-turn',
  },
  {
    kind: 'master_review',
    agent: Agent.MASTER_REVIEW,
    engine: 'codex',
    mode: 'execute',
    execution: 'top-level',
    reasoningEffort: 'xhigh',
    laneKind: 'builder',
    inputPolicy: 'none',
    operatorInput: false,
    taskScope: 'thread',
    runner: 'execute-turn',
  },
  {
    kind: 'post_build',
    agent: Agent.POST_BUILD,
    engine: 'claude',
    mode: 'conversational',
    execution: 'render-only',
    reasoningEffort: 'high',
    laneKind: 'main',
    inputPolicy: 'operator',
    operatorInput: false,
    taskScope: 'thread',
    runner: 'session-backed',
  },
  {
    kind: 'ci',
    agent: Agent.CI,
    engine: 'claude',
    mode: 'conversational',
    execution: 'render-only',
    reasoningEffort: 'high',
    laneKind: 'main',
    inputPolicy: 'operator',
    operatorInput: false,
    taskScope: 'thread',
    runner: 'session-backed',
  },
];

const BY_KIND = new Map<string, ThreadKindSpec>(THREAD_KIND_SPECS.map((s) => [s.kind, s]));

const THREAD_ROLE_SET = new Set<string>(THREAD_KIND_SPECS.map((s) => s.kind));

export function coerceThreadRole(raw: unknown): ThreadRole {
  const value = String(raw ?? '').trim();
  if (!THREAD_ROLE_SET.has(value)) {
    throw new Error(`thread-kind: "${value}" is not a valid ThreadRole.`);
  }
  return value as ThreadRole;
}

export const driverExecutableKinds: ReadonlySet<ThreadRole> = new Set(
  THREAD_KIND_SPECS.filter((s) => s.execution === 'top-level').map((s) => s.kind),
);

export function threadKindSpec(kind: string): ThreadKindSpec {
  const spec = BY_KIND.get(kind);
  if (!spec) throw new Error(`thread-kind: unknown kind "${kind}" (no ThreadKindSpec).`);
  return spec;
}

export function isDriverExecutableKind(kind: string): boolean {
  return driverExecutableKinds.has(kind as ThreadRole);
}

export interface LaneDefaultFooter {
  engine: SessionEngine;
  model?: string;
  effort?: ReasoningEffort;
}

export function laneDefaultFooter(kind: string): LaneDefaultFooter {
  const spec = threadKindSpec(kind);
  const claudeModel = spec.laneKind === 'main' ? CLAUDE_BRAIN_MODEL : CLAUDE_WORKER_MODEL;
  return {
    engine: spec.engine,
    ...(spec.engine === 'claude' ? { model: claudeModel } : {}),
    ...(spec.reasoningEffort ? { effort: spec.reasoningEffort } : {}),
  };
}

export function validateThreadKinds(specs: readonly ThreadKindSpec[] = THREAD_KIND_SPECS): void {
  const validAgents = new Set<string>(Object.values(Agent));
  const validLaneKinds = new Set<string>(THREAD_REGISTRY.map((d) => d.kind));
  const validKinds = new Set<string>(specs.map((s) => s.kind));
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.kind)) {
      throw new Error(`thread-kind: duplicate spec for kind "${s.kind}".`);
    }
    seen.add(s.kind);
    if (!validAgents.has(s.agent)) {
      throw new Error(`thread-kind: kind "${s.kind}" binds an unknown Agent "${s.agent}".`);
    }
    if (!validLaneKinds.has(s.laneKind)) {
      throw new Error(
        `thread-kind: kind "${s.kind}" names an unknown laneKind "${s.laneKind}" (not in THREAD_REGISTRY).`,
      );
    }
    if (s.children) {
      for (const child of s.children({ id: '(probe)', config: {} })) {
        if (!validKinds.has(child.kind)) {
          throw new Error(
            `thread-kind: kind "${s.kind}" declares a child of unknown kind "${child.kind}".`,
          );
        }
      }
    }
    try {
      renderAgentPrompt(s.agent, {});
    } catch (err) {
      throw new Error(
        `thread-kind: kind "${s.kind}" failed to render its Agent "${s.agent}" prompt: ${
          (err as Error).message
        }`,
      );
    }
  }
}
