import {
  EDefinitionOrigin,
  EFinishReason,
  toCallId,
  toRunId,
  type EventDraft,
  type ModelPort,
  type ModelStepResult,
  type ThreadId,
} from '@dltech/atlas-core'

import { buildHarness, type AtlasHarness } from '../../../loop/build-harness'
import { createTempDatabase } from '../../../loop/__tests__/temp-database'
import { ETurnStatus, type TurnOutcome } from '../../../loop/turn-outcome'
import type { TurnRunner } from '../../../loop/turn-runner.port'
import { scriptedModel } from '../../../model/testing/scripted-model'
import type { AgentType } from '../../types'
import type { ChildRunnerRequest, ChildRunnerSource } from '../child-runner'
import { AgentSupervisor } from '../supervisor'

export const agentTypeNamed = (args: Partial<AgentType> & { name: string }): AgentType => ({
  whenToUse: `use ${args.name}`,
  prompt: `You are the ${args.name} sub-agent.`,
  origin: EDefinitionOrigin.BuiltIn,
  ...args,
})

export type StartedRun = {
  request: ChildRunnerRequest
  threadId: ThreadId
  signal: AbortSignal
  settle: (outcome: TurnOutcome) => void
  fail: (cause: unknown) => void
  observe: (drafts: readonly EventDraft[]) => void
  observeContext: (args: { tokens: number; window: number }) => void
}

export type FakeRunners = {
  source: ChildRunnerSource
  readonly started: readonly StartedRun[]
  readonly resumed: readonly ThreadId[]
}

export function fakeRunners(): FakeRunners {
  const started: StartedRun[] = []
  const resumed: ThreadId[] = []

  const hold = (request: ChildRunnerRequest, signal: AbortSignal): Promise<TurnOutcome> =>
    new Promise<TurnOutcome>((resolve, reject) => {
      started.push({
        request,
        threadId: request.threadId,
        signal,
        settle: resolve,
        fail: reject,
        observe: request.observe,
        observeContext: request.observeContext,
      })
    })

  const source: ChildRunnerSource = (request) => ({
    say: ({ signal }) => hold(request, signal ?? new AbortController().signal),
    runTurn: ({ signal }) => hold(request, signal ?? new AbortController().signal),
    resume: ({ threadId, signal }) => {
      resumed.push(threadId)
      return hold(request, signal ?? new AbortController().signal)
    },
  })

  return { source, started, resumed }
}

export const finished = (): TurnOutcome => ({
  status: ETurnStatus.Completed,
  runId: toRunId('run_fake'),
})

export const interrupted = (): TurnOutcome => ({
  status: ETurnStatus.Interrupted,
  runId: toRunId('run_fake'),
  committed: true,
})

export const paused = (): TurnOutcome => ({
  status: ETurnStatus.Paused,
  runId: toRunId('run_fake'),
  callId: toCallId('call_fake'),
  reason: 'awaiting approval',
})

export const said = (text: string): readonly EventDraft[] => [
  { type: 'assistant-said', parts: [{ type: 'text', text }] },
]

export const calledTool = (name: string): readonly EventDraft[] => [
  { type: 'tool-called', callId: toCallId(`call_${name}`), name, ordinal: 0 },
]

export function fixedModelPort(args: { modelId: string; text: string }): ModelPort {
  return {
    identity: { id: 'fixed', modelId: args.modelId },
    step: (): Promise<ModelStepResult> =>
      Promise.resolve({
        parts: [{ type: 'text', text: args.text }],
        toolCalls: [],
        finishReason: EFinishReason.Stop,
      }),
  }
}

export const nothingRuns: ChildRunnerSource = (): TurnRunner => {
  throw new Error('no child should have been started')
}

export type OpenedSupervisor = {
  harness: AtlasHarness
  runners: FakeRunners
  supervisor: AgentSupervisor
  parent: ThreadId
  close: () => Promise<void>
}

export async function openSupervisor({
  agentTypes = [agentTypeNamed({ name: 'explore' }), agentTypeNamed({ name: 'builder' })],
}: { agentTypes?: readonly AgentType[] } = {}): Promise<OpenedSupervisor> {
  const temp = createTempDatabase()
  const harness = await buildHarness({
    databaseUrl: temp.databaseUrl,
    model: scriptedModel({ script: [] }),
  })
  const runners = fakeRunners()

  return {
    harness,
    runners,
    supervisor: new AgentSupervisor({
      log: harness.log,
      threads: harness.threads,
      ids: harness.ids,
      clock: harness.clock,
      agentTypes,
      runners: runners.source,
      launchDirectory: '/launch',
    }),
    parent: (await harness.threads.create({})).id,
    close: async () => {
      await harness.close()
      temp.discard()
    },
  }
}

export const settled = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
