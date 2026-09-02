import { z } from 'zod'

import {
  BeforeToolHook,
  DEFAULT_CLASSIFIER_POLICY,
  EClassifierMode,
  EToolEffect,
  JudgePort,
  ToolDefinition,
  WorkspaceFactsPort,
  toCallId,
  toThreadId,
  type BeforeToolOutcome,
  type ToolCall,
} from '@dltech/atlas-core'

import { createIsolatedContainer, portToken, resolveSet } from '../../container/injection'
import {
  ClassifierPolicyToken,
  HookMishapReporterToken,
  WorkspaceRoot,
} from '../../container/tokens'
import type { HookMishap } from '../../hooks/budget'
import { registerClassifier } from '../register-classifier'
import { factsInAWorktree, OURS, RecordingFacts, REPO, SIBLING } from './fixtures'

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'runs a command',
  effect: EToolEffect.Destructive,
  inputSchema: z.object({ command: z.string(), workdir: z.string().optional() }),
  invoke: async () => ({ ok: true, output: '', modelText: 'ran' }),
}

export const removingASiblingWorktree: ToolCall = {
  callId: toCallId('call-1'),
  name: 'bash',
  input: { command: `rm -rf ${SIBLING}` },
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread-1'),
}

export type ClassifierChain = {
  mishaps: readonly HookMishap[]
  bind: (judge: JudgePort) => void
  weigh: () => Promise<BeforeToolOutcome>
}

export function chainWith(args: {
  mode: EClassifierMode
  judge?: JudgePort | undefined
}): ClassifierChain {
  const container = createIsolatedContainer()
  container.register(portToken(ToolDefinition), { useValue: bashTool })
  container.register(portToken(WorkspaceFactsPort), {
    useValue: new RecordingFacts(factsInAWorktree({ siblingChangedCount: 12 })),
  })
  container.register(WorkspaceRoot, { useValue: REPO })
  if (args.judge !== undefined) container.register(portToken(JudgePort), { useValue: args.judge })

  registerClassifier({ container })
  container.register(ClassifierPolicyToken, {
    useValue: () => ({ ...DEFAULT_CLASSIFIER_POLICY, mode: args.mode }),
  })

  const classifier = resolveSet({ container, token: portToken(BeforeToolHook) }).find(
    (hook) => hook.name === 'classifyCall',
  )
  if (classifier === undefined) throw new Error('the classifier hook was never registered')

  const mishaps: HookMishap[] = []
  container.register(HookMishapReporterToken, {
    useValue: (mishap: HookMishap) => {
      mishaps.push(mishap)
    },
  })

  return {
    mishaps,
    bind: (judge: JudgePort) => {
      container.register(portToken(JudgePort), { useValue: judge })
    },
    weigh: () =>
      classifier.run({
        call: removingASiblingWorktree,
        projectDirectory: OURS,
        events: [],
        signal: new AbortController().signal,
      }),
  }
}
