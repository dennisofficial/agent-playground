import { describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  BeforeToolHook,
  DEFAULT_CLASSIFIER_POLICY,
  EBeforeToolDecision,
  EClassifierMode,
  EConsultation,
  EToolEffect,
  JudgePort,
  ToolDefinition,
  WorkspaceFactsPort,
  toCallId,
  toThreadId,
  type BeforeToolOutcome,
  type Consultation,
  type ToolCall,
} from '@dltech/atlas-core'

import { createIsolatedContainer, portToken, resolveSet } from '../../container/injection'
import { ClassifierPolicyToken, WorkspaceRoot } from '../../container/tokens'
import { registerClassifier } from '../register-classifier'
import { factsInAWorktree, judgedIn, OURS, RecordingFacts, REPO, SIBLING } from './fixtures'

class UnreachableJudge extends JudgePort {
  async consult(): Promise<Consultation> {
    return { kind: EConsultation.Unreachable, fault: 'fetch failed' }
  }
}

const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'runs a command',
  effect: EToolEffect.Destructive,
  inputSchema: z.object({ command: z.string(), workdir: z.string().optional() }),
  invoke: async () => ({ ok: true, output: '', modelText: 'ran' }),
}

const removingASiblingWorktree: ToolCall = {
  callId: toCallId('call-1'),
  name: 'bash',
  input: { command: `rm -rf ${SIBLING}` },
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread-1'),
}

async function armedNudgeOver(args: { judge?: JudgePort | undefined }): Promise<BeforeToolOutcome> {
  const container = createIsolatedContainer()
  container.register(portToken(ToolDefinition), { useValue: bashTool })
  container.register(portToken(WorkspaceFactsPort), {
    useValue: new RecordingFacts(factsInAWorktree({ siblingChangedCount: 12 })),
  })
  container.register(WorkspaceRoot, { useValue: REPO })
  if (args.judge !== undefined) container.register(portToken(JudgePort), { useValue: args.judge })

  registerClassifier({ container })
  container.register(ClassifierPolicyToken, {
    useValue: () => ({ ...DEFAULT_CLASSIFIER_POLICY, mode: EClassifierMode.Nudge }),
  })

  const classifier = resolveSet({ container, token: portToken(BeforeToolHook) }).find(
    (hook) => hook.name === 'classifyCall',
  )
  if (classifier === undefined) throw new Error('the classifier hook was never registered')

  return classifier.run({
    call: removingASiblingWorktree,
    projectDirectory: OURS,
    events: [],
    signal: new AbortController().signal,
  })
}

describe('the classifier chain built without a judge', () => {
  it('cannot pause the operator, because nothing read the evidence', async () => {
    const outcome = await armedNudgeOver({ judge: undefined })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
    expect(judgedIn(outcome).mode).toBe(EClassifierMode.Shadow)
  })

  it('still records what it would have asked about, so the silence is visible', async () => {
    const judged = judgedIn(await armedNudgeOver({ judge: undefined }))

    expect(judged.wouldAsk).toBe(true)
    expect(judged.details?.join(' ')).toContain(SIBLING)
  })

  it('pauses on the same call once a judge is bound and cannot be reached', async () => {
    const outcome = await armedNudgeOver({ judge: new UnreachableJudge() })

    expect(outcome.decision).toBe(EBeforeToolDecision.Ask)
  })
})
