import { z } from 'zod'

import {
  DEFAULT_CLASSIFIER_POLICY,
  EClassifierMode,
  EContentAccess,
  EOccupancy,
  EPathForm,
  EPathPresence,
  EToolEffect,
  NO_FACTS,
  toCallId,
  toThreadId,
  WorkspaceFactsPort,
  type ClassifierPolicy,
  type Event,
  type FactRequest,
  type ToolCall,
  type ToolDeclaration,
  type WorkspaceFacts,
} from '@dltech/atlas-core'

import { ClassifyCallHook, type ClassifyCallDeps } from '../classify-call'

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
    gatheredFor: [],
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

export function hookOver(deps: Partial<ClassifyCallDeps> & { facts: WorkspaceFactsPort }) {
  return new ClassifyCallHook({
    tools: TOOLS,
    launchDirectory: REPO,
    policy: policyIn(EClassifierMode.Shadow),
    now: () => 0,
    ...deps,
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
