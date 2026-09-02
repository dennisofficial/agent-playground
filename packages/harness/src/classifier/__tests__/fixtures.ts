import { z } from 'zod'

import {
  DEFAULT_CLASSIFIER_POLICY,
  EClassifierMode,
  EContentAccess,
  EDeedRealm,
  EOccupancy,
  EPathForm,
  EPathPresence,
  EToolEffect,
  NO_FACTS,
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  WorkspaceFactsPort,
  type ClassifierPolicy,
  type Event,
  type EventDraft,
  type FactRequest,
  type ToolCall,
  type ToolDeclaration,
  type WorkspaceFacts,
} from '@dltech/atlas-core'

import { ClassifyCallHook, type ClassifyCallDeps, type JudgeSeam } from '../classify-call'

export const REPO = '/repo'
export const OURS = `${REPO}/.claude/worktrees/eng-327-api-eslint`
export const SIBLING = `${REPO}/.claude/worktrees/eng-412-sidebar`

const absolute = (field: string, content: EContentAccess, presence: EPathPresence) => ({
  field,
  presence,
  form: EPathForm.Absolute,
  content,
})

export const TOOLS: readonly ToolDeclaration[] = [
  {
    name: 'read',
    description: 'reads a file',
    effect: EToolEffect.Read,
    inputSchema: z.object({ path: z.string() }),
    pathFields: [absolute('path', EContentAccess.Reads, EPathPresence.Required)],
  },
  {
    name: 'grep',
    description: 'searches',
    effect: EToolEffect.Read,
    inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
    pathFields: [absolute('path', EContentAccess.None, EPathPresence.Optional)],
  },
  {
    name: 'edit',
    description: 'edits a file',
    effect: EToolEffect.Write,
    inputSchema: z.object({ path: z.string(), text: z.string() }),
    pathFields: [absolute('path', EContentAccess.Amends, EPathPresence.Required)],
  },
  {
    name: 'bash',
    description: 'runs a command',
    effect: EToolEffect.Destructive,
    inputSchema: z.object({ command: z.string(), workdir: z.string().optional() }),
    pathFields: [absolute('workdir', EContentAccess.None, EPathPresence.Optional)],
  },
]

export function callTo(args: { name: string; input: unknown }): ToolCall {
  const effect = TOOLS.find((tool) => tool.name === args.name)?.effect ?? EToolEffect.Destructive
  return {
    callId: toCallId('call-1'),
    name: args.name,
    input: args.input,
    effect,
    threadId: toThreadId('thread-1'),
  }
}

export function factsInAWorktree(args?: {
  siblingChangedCount?: number | undefined
}): WorkspaceFacts {
  return {
    projectDirectory: OURS,
    launchDirectory: REPO,
    repo: REPO,
    worktrees: [
      {
        path: REPO,
        branch: 'main',
        isMain: true,
        occupancy: EOccupancy.Unknown,
        heldBy: undefined,
        changedCount: 276,
        unpushedCommits: 0,
      },
      {
        path: OURS,
        branch: 'dennis/eng-327-api-eslint',
        isMain: false,
        occupancy: EOccupancy.Ours,
        heldBy: undefined,
        changedCount: 2,
        unpushedCommits: 0,
      },
      {
        path: SIBLING,
        branch: 'dennis/eng-412-sidebar',
        isMain: false,
        occupancy: EOccupancy.Unknown,
        heldBy: undefined,
        changedCount: args?.siblingChangedCount ?? 3,
        unpushedCommits: 0,
      },
    ],
    refs: [],
    ownChangedPaths: [],
    regenerablePaths: ['node_modules', 'dist'],
    gatheredFor: [EDeedRealm.Path, EDeedRealm.GitWorktree],
  }
}

export class RecordingFacts extends WorkspaceFactsPort {
  readonly requests: FactRequest[] = []

  constructor(private readonly answer: WorkspaceFacts | Error = NO_FACTS) {
    super()
  }

  async factsFor(request: FactRequest): Promise<WorkspaceFacts> {
    this.requests.push(request)
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }

  prewarm(): void {}

  invalidate(): void {}
}

export function policyIn(mode: EClassifierMode): () => ClassifierPolicy {
  return () => ({ ...DEFAULT_CLASSIFIER_POLICY, mode })
}

export function hookOver(
  deps: Partial<Omit<ClassifyCallDeps, 'judge'>> & {
    facts: WorkspaceFactsPort
    judge?: JudgeSeam | undefined
  },
) {
  const { judge, ...rest } = deps

  return new ClassifyCallHook({
    tools: TOOLS,
    launchDirectory: REPO,
    policy: policyIn(EClassifierMode.Shadow),
    now: () => 0,
    ...rest,
    ...(judge === undefined ? {} : { judge: () => judge }),
  })
}

export async function classify(args: {
  hook: ClassifyCallHook
  call: ToolCall
  projectDirectory?: string | undefined
  events?: readonly Event[] | undefined
}) {
  return args.hook.run({
    call: args.call,
    projectDirectory: args.projectDirectory ?? OURS,
    events: args.events ?? [],
    signal: new AbortController().signal,
  })
}

export const stamped = (drafts: readonly EventDraft[]): readonly Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${String(index + 1)}`),
      seq: index + 1,
      threadId: toThreadId('thread-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: '2026-09-01T00:00:00.000Z',
    })),
  })

export function judgedIn(outcome: { drafts?: readonly EventDraft[] | undefined }) {
  const draft = (outcome.drafts ?? []).find((one) => one.type === 'classifier-judged')
  if (draft?.type !== 'classifier-judged') throw new Error('no classifier-judged draft was written')
  return draft
}
