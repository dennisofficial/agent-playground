import { afterEach, describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { EToolEffect, toCallId, type ToolDeclaration } from '@dltech/atlas-core'

import type { ToolDispatcher } from '../../tools/dispatch'
import { createSettlePending, type ToolOutputNotice } from '../settle-pending'
import { branchWithCalls, discardOpened, openLog } from './settle-pending-fixture'

afterEach(discardOpened)

const readDeclaration: ToolDeclaration = {
  name: 'read',
  description: 'the read tool',
  effect: EToolEffect.Read,
  inputSchema: z.object({}),
  isConcurrencySafe: () => true,
}

const narratingDispatch = (
  lines: (callId: string) => readonly { stream: 'stdout' | 'stderr'; text: string }[],
): ToolDispatcher => ({
  dispatch: async (args) => {
    for (const chunk of lines(args.call.callId)) {
      args.onOutput?.(chunk)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return [
      {
        type: 'tool-result',
        callId: args.call.callId,
        name: args.call.name,
        output: 'done',
        modelText: 'done',
      },
    ]
  },
})

describe('tool output streaming through settle-pending', () => {
  it('attributes each chunk to the call that printed it, even inside a parallel batch', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({
      harness,
      calls: [
        { callId: 'call-1', name: 'read' },
        { callId: 'call-2', name: 'read' },
      ],
    })
    const notices: ToolOutputNotice[] = []
    const settle = createSettlePending({
      log: harness.log,
      dispatch: narratingDispatch((callId) => [
        { stream: 'stdout', text: `begin ${callId}\n` },
        { stream: 'stderr', text: `end ${callId}\n` },
      ]),
      tools: () => [readDeclaration],
      onToolOutput: (notice) => notices.push(notice),
    })

    const settled = await settle({ threadId, signal: new AbortController().signal })

    expect(settled).toEqual({})
    const byCall = (callId: string) => notices.filter((notice) => notice.callId === toCallId(callId))
    expect(byCall('call-1')).toEqual([
      { callId: toCallId('call-1'), stream: 'stdout', text: 'begin call-1\n' },
      { callId: toCallId('call-1'), stream: 'stderr', text: 'end call-1\n' },
    ])
    expect(byCall('call-2')).toEqual([
      { callId: toCallId('call-2'), stream: 'stdout', text: 'begin call-2\n' },
      { callId: toCallId('call-2'), stream: 'stderr', text: 'end call-2\n' },
    ])
    expect(notices[0]?.text).toBe('begin call-1\n')
    expect(notices[1]?.text).toBe('begin call-2\n')
  })

  it('leaves the tap undefined for the dispatcher when nobody listens', async () => {
    const harness = await openLog()
    const { threadId } = await branchWithCalls({ harness, calls: [{ callId: 'call-1', name: 'read' }] })
    let carried: unknown = 'untouched'
    const settle = createSettlePending({
      log: harness.log,
      dispatch: {
        dispatch: async (args) => {
          carried = args.onOutput
          return [
            {
              type: 'tool-result' as const,
              callId: args.call.callId,
              name: args.call.name,
              output: 'done',
              modelText: 'done',
            },
          ]
        },
      },
    })

    await settle({ threadId, signal: new AbortController().signal })

    expect(carried).toBeUndefined()
  })
})
