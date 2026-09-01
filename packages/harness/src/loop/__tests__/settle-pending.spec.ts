import { afterEach, describe, expect, it } from 'bun:test'

import { toCallId, type EventDraft } from '@dltech/atlas-core'

import type { DispatchableCall, ToolDispatcher } from '../../tools/dispatch'
import { createSettlePending } from '../settle-pending'
import {
  branchWithCalls,
  discardOpened,
  openLog,
  scriptedDispatch,
} from './settle-pending-fixture'

afterEach(discardOpened)

describe('settling the calls a step left pending', () => {
  it('appends what dispatch returns and reports no pause', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({ harness, calls: [{ callId: 'call-1', name: 'edit' }] })
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen }) })

    const settled = await settle({ threadId, signal: new AbortController().signal })

    expect(settled).toEqual({})
    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-1')])
    const events = await harness.log.read({ threadId })
    expect(events.map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
      'tool-called',
      'tool-result',
    ])
  })

  it('settles every call of the step in ordinal order, whatever order the log holds them in', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-late', name: 'edit', ordinal: 1 },
        { callId: 'call-early', name: 'read', ordinal: 0 },
      ],
    })
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen }) })

    await settle({ threadId, signal: new AbortController().signal })

    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-early'), toCallId('call-late')])
  })

  it('stops at an approval request, appends it, and reports the pause', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-2', name: 'bash' },
        { callId: 'call-3', name: 'read' },
      ],
    })
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({
      log: harness.log,
      dispatch: scriptedDispatch({
        seen,
        draftsFor: (call) =>
          call.name === 'bash'
            ? [{ type: 'approval-requested', callId: call.callId, reason: 'bash needs a human' }]
            : [{ type: 'tool-result', callId: call.callId, name: call.name, output: 'done', modelText: 'done' }],
      }),
    })

    const settled = await settle({ threadId, signal: new AbortController().signal })

    expect(settled).toEqual({ paused: { callId: toCallId('call-2'), reason: 'bash needs a human' } })
    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-1'), toCallId('call-2')])
    const events = await harness.log.read({ threadId })
    expect(events.map((event) => event.type).slice(-2)).toEqual(['tool-result', 'approval-requested'])
  })

  it('stops before the next call once the signal is aborted, keeping what already ran', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-2', name: 'read' },
      ],
    })
    const controller = new AbortController()
    const seen: DispatchableCall[] = []
    const settle = createSettlePending({
      log: harness.log,
      dispatch: scriptedDispatch({
        seen,
        draftsFor: (call) => {
          controller.abort()
          return [{ type: 'tool-result', callId: call.callId, name: call.name, output: 'done', modelText: 'done' }]
        },
      }),
    })

    const settled = await settle({ threadId, signal: controller.signal })

    expect(settled).toEqual({})
    expect(seen.map((call) => call.callId)).toEqual([toCallId('call-1')])
    const events = await harness.log.read({ threadId })
    expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(1)
  })

  it('stamps a result with the run that emitted the call, so a resumed turn logs what an unbroken one would', async () => {
    const harness = await openLog()
    const { threadId, runId: emittingRun } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call-1', name: 'read' }],
    })
    const laterRun = harness.ids.nextRunId()
    await harness.log.append({
      threadId,
      runId: laterRun,
      drafts: [
        { type: 'assistant-said', parts: [{ type: 'text', text: 'and one more' }] },
        { type: 'tool-called', callId: toCallId('call-2'), name: 'read', input: {}, ordinal: 1 },
      ],
    })
    const settle = createSettlePending({ log: harness.log, dispatch: scriptedDispatch({ seen: [] }) })

    await settle({ threadId, signal: new AbortController().signal })

    const events = await harness.log.read({ threadId })
    const stampedBy = new Map(
      events
        .filter((event) => event.type === 'tool-result')
        .map((event) => [event.type === 'tool-result' ? event.callId : '', event.runId]),
    )
    expect(stampedBy.get(toCallId('call-1'))).toBe(emittingRun)
    expect(stampedBy.get(toCallId('call-2'))).toBe(laterRun)
    expect(emittingRun).not.toBe(laterRun)
  })
})


describe('carrying the project directory across tool calls', () => {
  const directoriesSeen = (seen: { projectDirectory: string }[]): readonly string[] =>
    seen.map((entry) => entry.projectDirectory)

  const recordingDispatch = (args: {
    seen: { projectDirectory: string }[]
    moves: Map<string, string>
  }): ToolDispatcher => {
    const dispatch = async (call: {
      call: DispatchableCall
      projectDirectory: string
    }): Promise<readonly EventDraft[]> => {
      args.seen.push({ projectDirectory: call.projectDirectory })
      const moved = args.moves.get(call.call.callId)
      return [
        { type: 'tool-result', callId: call.call.callId, name: call.call.name, output: {} },
        ...(moved === undefined
          ? []
          : [
              {
                type: 'worktree-entered' as const,
                path: moved,
                branch: 'topic',
                base: 'origin/main',
              },
            ]),
      ]
    }
    return { dispatch } as unknown as ToolDispatcher
  }

  it('starts at the project directory when nothing has moved', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({ harness, calls: [{ callId: 'call_1', name: 'bash' }] })
    const seen: { projectDirectory: string }[] = []

    const settle = createSettlePending({
      log: harness.log,
      dispatch: recordingDispatch({ seen, moves: new Map() }),
      launchDirectory: '/project',
    })
    await settle({ threadId, signal: new AbortController().signal })

    expect(directoriesSeen(seen)).toEqual(['/project'])
  })

  it('hands a later call the worktree an earlier call entered', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call_1', name: 'bash' }, { callId: 'call_2', name: 'bash' }],
    })
    const seen: { projectDirectory: string }[] = []

    const settle = createSettlePending({
      log: harness.log,
      dispatch: recordingDispatch({ seen, moves: new Map([['call_1', '/project/.claude/worktrees/topic']]) }),
      launchDirectory: '/project',
    })
    await settle({ threadId, signal: new AbortController().signal })

    expect(directoriesSeen(seen)).toEqual(['/project', '/project/.claude/worktrees/topic'])
  })

  it('resumes from the worktree a previous turn already entered', async () => {
    const harness = await openLog()
    const { threadId, runId } = await branchWithCalls({
      harness,
      calls: [{ callId: 'call_1', name: 'bash' }],
    })
    await harness.log.append({
      threadId,
      runId,
      drafts: [
        { type: 'worktree-entered', path: '/project/.claude/worktrees/topic', branch: 'topic', base: 'origin/main' },
      ],
    })
    const seen: { projectDirectory: string }[] = []

    const settle = createSettlePending({
      log: harness.log,
      dispatch: recordingDispatch({ seen, moves: new Map() }),
      launchDirectory: '/project',
    })
    await settle({ threadId, signal: new AbortController().signal })

    expect(directoriesSeen(seen)).toEqual(['/project/.claude/worktrees/topic'])
  })
})
