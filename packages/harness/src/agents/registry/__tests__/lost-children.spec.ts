import { afterEach, describe, expect, it } from 'bun:test'

import {
  EAgentStatus,
  EKilledBy,
  EMessageOrigin,
  ERewindRefusal,
  toCallId,
  type EventDraft,
  type ThreadId,
} from '@dltech/atlas-core'

import { rewindThread } from '../../../store/rewind'
import { openChildThread } from '../open-child'
import {
  agentTypeNamed,
  finished,
  openSupervisor,
  settled,
  type OpenedSupervisor,
} from './fixtures'

const opened: OpenedSupervisor[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

const spoke = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})

const worked: readonly EventDraft[] = [
  spoke('looking'),
  { type: 'tool-called', callId: toCallId('call_read'), name: 'read_file', ordinal: 0 },
  spoke('four callers, in two files'),
]

async function crashedWith(drafts: readonly EventDraft[]): Promise<OpenedSupervisor> {
  const open = await openSupervisor()
  opened.push(open)

  const agentId = await openChildThread({
    threads: open.harness.threads,
    log: open.harness.log,
    ids: open.harness.ids,
    spawnedBy: open.parent,
    agentType: agentTypeNamed({ name: 'explore' }),
    brief: 'find the callers',
    intent: 'find the callers',
  })
  if (drafts.length > 0) {
    await open.harness.log.append({
      threadId: agentId,
      runId: open.harness.ids.nextRunId(),
      drafts,
    })
  }

  return open
}

const endingsIn = async (open: OpenedSupervisor, threadId?: ThreadId) =>
  (await open.harness.log.read({ threadId: threadId ?? open.parent })).filter(
    (event) => event.type === 'agent-ended',
  )

describe('a child the process lost, found again at recovery', () => {
  it('writes the ending nobody was alive to write, blaming no one', async () => {
    const open = await crashedWith(worked)

    const recovered = await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(recovered.settled).toHaveLength(1)
    expect(recovered.settled[0]).toMatchObject({
      status: EAgentStatus.Stopped,
      killedBy: EKilledBy.Unrecorded,
    })

    const [ending] = await endingsIn(open)
    expect(ending?.type === 'agent-ended' ? ending : undefined).toMatchObject({
      status: EAgentStatus.Stopped,
      killedBy: EKilledBy.Unrecorded,
      turns: 2,
      toolCalls: 1,
      prose: 'four callers, in two files',
    })
  })

  it('hands the parent whatever the child had said before it went', async () => {
    const open = await crashedWith([spoke('I had read four files')])

    const { settled: [snapshot] } = await open.supervisor.recordLostAgents({
      threadId: open.parent,
    })

    expect(snapshot?.turns).toBe(1)
    expect(open.supervisor.list({ threadId: open.parent })[0]?.endedAt).toBeDefined()
  })

  it('counts a child lost before it said anything, rather than refusing to settle it', async () => {
    const open = await crashedWith([])

    const { settled: [snapshot] } = await open.supervisor.recordLostAgents({
      threadId: open.parent,
    })

    expect(snapshot).toMatchObject({ turns: 0, toolCalls: 0 })
  })

  it('settles each lost child once, however often recovery runs', async () => {
    const open = await crashedWith(worked)

    await open.supervisor.recordLostAgents({ threadId: open.parent })
    const again = await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(again.settled).toHaveLength(0)
    expect(await endingsIn(open)).toHaveLength(1)
  })

  it('leaves a child this process is still stepping alone', async () => {
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

    const lost = await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(lost.settled).toHaveLength(0)
    expect(await endingsIn(open)).toHaveLength(0)

    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()
  })

  it('leaves a child that already ended alone', async () => {
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
    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()

    const recovered = await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(recovered.settled).toHaveLength(0)
  })
})

describe('the rewind a lost child was blocking', () => {
  it('is refused while the spawn has no ending, and allowed once recovery writes one', async () => {
    const open = await crashedWith(worked)
    const rewind = () =>
      rewindThread({
        log: open.harness.log,
        threads: open.harness.threads,
        threadId: open.parent,
        toSeq: 0,
      })

    expect(await rewind()).toMatchObject({ ok: false, refusal: ERewindRefusal.UnendedSubAgent })

    await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(await rewind()).toMatchObject({ ok: true })
  })
})

async function unloggedChild(open: OpenedSupervisor): Promise<ThreadId> {
  const { thread } = await open.harness.threads.createWithFirstEvents({
    runId: open.harness.ids.nextRunId(),
    drafts: [{ type: 'user-said', text: 'find the callers', via: EMessageOrigin.ParentAgent }],
    title: 'explore: find the callers',
    agent: { spawnedBy: open.parent, type: 'explore' },
  })

  return thread.id
}

describe('a child thread the parent never recorded', () => {
  it('is reported rather than healed, and nothing is written for it', async () => {
    const open = await openSupervisor()
    opened.push(open)
    const agentId = await unloggedChild(open)

    const recovered = await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(recovered.settled).toHaveLength(0)
    expect(recovered.unlogged).toEqual([
      {
        agentId,
        agentType: 'explore',
        title: 'explore: find the callers',
        startedAt: expect.any(String),
      },
    ])
    expect(await endingsIn(open)).toHaveLength(0)
    expect(await open.harness.log.read({ threadId: open.parent })).toHaveLength(0)
  })

  it('leaves the parent rewindable, having invented no spawn to refuse one', async () => {
    const open = await openSupervisor()
    opened.push(open)
    await unloggedChild(open)

    await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(
      await rewindThread({
        log: open.harness.log,
        threads: open.harness.threads,
        threadId: open.parent,
        toSeq: 0,
      }),
    ).toMatchObject({ ok: true })
  })

  it('reports nothing for a child the parent did record, whether lost or ended', async () => {
    const open = await crashedWith(worked)

    const recovered = await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(recovered.settled).toHaveLength(1)
    expect(recovered.unlogged).toHaveLength(0)
  })

  it('reports nothing for a child this process spawned itself', async () => {
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

    const recovered = await open.supervisor.recordLostAgents({ threadId: open.parent })

    expect(recovered.unlogged).toHaveLength(0)

    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()
  })
})
