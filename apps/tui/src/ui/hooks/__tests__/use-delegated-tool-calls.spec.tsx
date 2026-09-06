import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { EAgentStatus, toThreadId, type ThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'

import { settle, teardown } from '../../markdown/__tests__/harness'
import { useDelegatedToolCalls, type DelegatedProgress } from '../use-delegated-tool-calls'

const RENDER_MS = 40

const PARENT = toThreadId('thread-parent')
const ELSEWHERE = toThreadId('thread-elsewhere')

const child = (args: {
  agentId: string
  spawnedBy: ThreadId
  toolCalls: number
  status?: EAgentStatus
}): AgentSnapshot => ({
  agentId: toThreadId(args.agentId),
  spawnedBy: args.spawnedBy,
  agentType: 'builder',
  intent: 'work',
  status: args.status ?? EAgentStatus.Running,
  turns: 1,
  toolCalls: args.toolCalls,
  lastTool: undefined,
  startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  endedAt: undefined,
})

type FakeRoster = DelegatedProgress & {
  record: (snapshot: AgentSnapshot) => void
}

const fakeRoster = (): FakeRoster => {
  const children: AgentSnapshot[] = []
  const listeners = new Set<() => void>()
  return {
    record: (snapshot) => {
      const existing = children.findIndex((held) => held.agentId === snapshot.agentId)
      if (existing === -1) children.push(snapshot)
      else children.splice(existing, 1, snapshot)
      for (const listener of [...listeners]) listener()
    },
    list: ({ threadId }) => children.filter((held) => held.spawnedBy === threadId),
    onChange: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

async function mounted(args: { roster: FakeRoster }): Promise<{
  read: () => number
  done: () => Promise<void>
}> {
  let current = -1
  const Watcher = (): React.ReactNode => {
    current = useDelegatedToolCalls({ agents: args.roster, threadId: PARENT })
    return <text>{current}</text>
  }

  const setup = await testRender(<Watcher />, { width: 40, height: 2 })
  await act(async () => {
    await settle(RENDER_MS)
  })
  await setup.flush()

  return {
    read: () => current,
    done: () => teardown(setup),
  }
}

describe('useDelegatedToolCalls', () => {
  it('starts at the tool calls already on this thread’s children', async () => {
    const roster = fakeRoster()
    roster.record(child({ agentId: 'child-1', spawnedBy: PARENT, toolCalls: 7 }))
    roster.record(child({ agentId: 'child-2', spawnedBy: PARENT, toolCalls: 5 }))

    const { read, done } = await mounted({ roster })
    try {
      expect(read()).toBe(12)
    } finally {
      await done()
    }
  })

  it('grows as a child’s tool calls grow', async () => {
    const roster = fakeRoster()
    const { read, done } = await mounted({ roster })

    try {
      expect(read()).toBe(0)

      await act(async () => {
        roster.record(child({ agentId: 'child-1', spawnedBy: PARENT, toolCalls: 3 }))
        await settle(RENDER_MS)
      })
      expect(read()).toBe(3)

      await act(async () => {
        roster.record(child({ agentId: 'child-1', spawnedBy: PARENT, toolCalls: 9 }))
        await settle(RENDER_MS)
      })
      expect(read()).toBe(9)
    } finally {
      await done()
    }
  })

  it('keeps an ended child’s calls and ignores children of other threads', async () => {
    const roster = fakeRoster()
    roster.record(
      child({ agentId: 'child-1', spawnedBy: PARENT, toolCalls: 4, status: EAgentStatus.Finished }),
    )
    roster.record(child({ agentId: 'child-2', spawnedBy: ELSEWHERE, toolCalls: 30 }))

    const { read, done } = await mounted({ roster })
    try {
      expect(read()).toBe(4)
    } finally {
      await done()
    }
  })
})
