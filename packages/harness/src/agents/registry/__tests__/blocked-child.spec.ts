import { afterEach, describe, expect, it } from 'bun:test'

import { agentEnding, EAgentStatus } from '@dltech/atlas-core'

import { openSupervisor, paused, settled, type OpenedSupervisor } from './fixtures'

const opened: OpenedSupervisor[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

async function spawnAndPause(): Promise<{ status: EAgentStatus; turns: number; calls: number }> {
  const open = await openSupervisor()
  opened.push(open)

  const outcome = await open.supervisor.spawn({
    threadId: open.parent,
    agentType: 'builder',
    brief: 'write the thing',
    intent: 'write the thing',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  await settled()

  open.runners.started[0]?.settle(paused())
  await open.supervisor.closeAll()

  const [draft] = open.supervisor.drainNotifications({ threadId: open.parent })
  if (draft?.type !== 'agent-ended') throw new Error('the parent was told nothing')

  return { status: draft.status, turns: draft.turns, calls: draft.toolCalls }
}

describe('a child whose tool call needs an approval it cannot answer', () => {
  it('is handed to the parent as blocked, not as an agent someone stopped', async () => {
    const ending = await spawnAndPause()

    expect(ending.status).toBe(EAgentStatus.Blocked)
  })

  it('reads to the parent as blocked on an approval', async () => {
    const ending = await spawnAndPause()
    const sentence = agentEnding({
      status: ending.status,
      turns: ending.turns,
      toolCalls: ending.calls,
    })

    expect(sentence).toContain('is blocked on an approval it cannot answer')
    expect(sentence).not.toContain('stopped')
  })
})
