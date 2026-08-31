import { afterEach, describe, expect, it } from 'bun:test'

import { agentEnding, EAgentStatus, EKilledBy, type EventDraft } from '@dltech/atlas-core'

import { finished, interrupted, openSupervisor, settled, type OpenedSupervisor } from './fixtures'

const opened: OpenedSupervisor[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

async function spawned(): Promise<OpenedSupervisor> {
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

  return open
}

type Ending = Extract<EventDraft, { type: 'agent-ended' }>

const endingsFor = (open: OpenedSupervisor): readonly Ending[] =>
  open.supervisor
    .drainNotifications({ threadId: open.parent })
    .flatMap((draft) => (draft.type === 'agent-ended' ? [draft] : []))

const lastEnding = (open: OpenedSupervisor): Ending => {
  const ending = endingsFor(open).at(-1)
  if (ending === undefined) throw new Error('the parent was told nothing')
  return ending
}

const agentIdOf = (open: OpenedSupervisor): Ending['agentId'] => {
  const child = open.supervisor.list({ threadId: open.parent })[0]
  if (child === undefined) throw new Error('nothing was spawned')
  return child.agentId
}

describe('a sub-agent the operator stopped', () => {
  it('records the operator on the ending the parent is handed', async () => {
    const open = await spawned()

    open.supervisor.stop({ agentId: agentIdOf(open), threadId: open.parent, by: EKilledBy.User })
    open.runners.started[0]?.settle(interrupted())
    await open.supervisor.closeAll()

    const ending = lastEnding(open)
    expect(ending.status).toBe(EAgentStatus.Stopped)
    expect(ending.killedBy).toBe(EKilledBy.User)
    expect(agentEnding(ending)).toContain('was stopped by the user')
  })

  it('records the parent when the parent stopped it, so the two never read alike', async () => {
    const open = await spawned()

    open.supervisor.stop({ agentId: agentIdOf(open), threadId: open.parent, by: EKilledBy.Model })
    open.runners.started[0]?.settle(interrupted())
    await open.supervisor.closeAll()

    const ending = lastEnding(open)
    expect(ending.killedBy).toBe(EKilledBy.Model)
    expect(agentEnding(ending)).toContain('was stopped at your request')
  })

  it('is stopped rather than failed when the abort came back as a throw', async () => {
    const open = await spawned()

    open.supervisor.stop({ agentId: agentIdOf(open), threadId: open.parent, by: EKilledBy.User })
    open.runners.started[0]?.fail(new Error('the model stream was aborted'))
    await open.supervisor.closeAll()

    const ending = lastEnding(open)
    expect(ending.status).toBe(EAgentStatus.Stopped)
    expect(ending.killedBy).toBe(EKilledBy.User)
  })

  it('loses the attribution when it is sent on again, which nobody stopped', async () => {
    const open = await spawned()
    const agentId = agentIdOf(open)

    open.supervisor.stop({ agentId, threadId: open.parent, by: EKilledBy.User })
    open.runners.started[0]?.settle(interrupted())
    await open.supervisor.closeAll()
    expect(lastEnding(open).killedBy).toBe(EKilledBy.User)

    await open.supervisor.say({ agentId, threadId: open.parent, text: 'carry on' })
    await settled()
    open.runners.started[1]?.settle(finished())
    await open.supervisor.closeAll()

    const ending = lastEnding(open)
    expect(ending.status).toBe(EAgentStatus.Finished)
    expect(ending.killedBy).toBeUndefined()
  })

  it('keeps the record of a child that had already ended, which no stop reaches', async () => {
    const open = await spawned()
    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()

    const outcome = open.supervisor.stop({
      agentId: agentIdOf(open),
      threadId: open.parent,
      by: EKilledBy.User,
    })

    expect(outcome).toMatchObject({ ok: true })
    if (!outcome.ok) return
    expect(outcome.snapshot.status).toBe(EAgentStatus.Finished)
    expect(outcome.snapshot.killedBy).toBeUndefined()
  })
})

describe('a sub-agent still stepping when the session closes', () => {
  it('ends as stopped by teardown, not as a decision anyone took', async () => {
    const open = await spawned()

    const closing = open.supervisor.closeAll()
    open.runners.started[0]?.settle(interrupted())
    await closing

    const ending = lastEnding(open)
    expect(ending.status).toBe(EAgentStatus.Stopped)
    expect(ending.killedBy).toBe(EKilledBy.SessionEnd)
    expect(agentEnding(ending)).toContain('was stopped when the session closed')
  })

  it('keeps an operator stop that was already in flight', async () => {
    const open = await spawned()

    open.supervisor.stop({ agentId: agentIdOf(open), threadId: open.parent, by: EKilledBy.User })
    const closing = open.supervisor.closeAll()
    open.runners.started[0]?.settle(interrupted())
    await closing

    expect(lastEnding(open).killedBy).toBe(EKilledBy.User)
  })
})
