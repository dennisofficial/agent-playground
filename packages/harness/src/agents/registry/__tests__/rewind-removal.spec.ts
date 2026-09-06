import { afterEach, describe, expect, it } from 'bun:test'

import {
  EAgentStatus,
  ECompactionAnchor,
  EForkMode,
  EKilledBy,
  EMessageOrigin,
  type EventDraft,
  type ThreadId,
} from '@dltech/atlas-core'

import { compactThread } from '../../../store/compact'
import { rewindThread } from '../../../store/rewind'
import { openChildThread } from '../open-child'
import {
  agentTypeNamed,
  finished,
  nothingRuns,
  openSupervisor,
  settled,
  type OpenedSupervisor,
} from './fixtures'
import { AgentSupervisor } from '../supervisor'

const opened: OpenedSupervisor[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

const openAndTrack = async (): Promise<OpenedSupervisor> => {
  const entry = await openSupervisor()
  opened.push(entry)
  return entry
}

const ended = (agentId: ThreadId): EventDraft => ({
  type: 'agent-ended',
  agentId,
  agentType: 'explore',
  intent: 'find the callers',
  status: EAgentStatus.Stopped,
  killedBy: EKilledBy.User,
  prose: 'four callers, in two files',
  turns: 3,
  toolCalls: 2,
})

async function completedDelegation(entry: OpenedSupervisor): Promise<ThreadId> {
  const agentId = await openChildThread({
    threads: entry.harness.threads,
    log: entry.harness.log,
    ids: entry.harness.ids,
    spawnedBy: entry.parent,
    agentType: agentTypeNamed({ name: 'explore' }),
    brief: 'find the callers',
    intent: 'find the callers',
  })
  await entry.harness.log.append({
    threadId: entry.parent,
    runId: entry.harness.ids.nextRunId(),
    drafts: [ended(agentId)],
  })
  return agentId
}

const rewindToStart = (entry: OpenedSupervisor) =>
  rewindThread({
    log: entry.harness.log,
    threads: entry.harness.threads,
    agents: entry.supervisor,
    threadId: entry.parent,
    toSeq: 0,
  })

const deliverNotices = async (entry: OpenedSupervisor): Promise<void> => {
  const drafts = entry.supervisor.drainNotifications({ threadId: entry.parent })
  if (drafts.length === 0) return
  await entry.harness.log.append({
    threadId: entry.parent,
    runId: entry.harness.ids.nextRunId(),
    drafts,
  })
}

const freshSupervisor = (entry: OpenedSupervisor): AgentSupervisor =>
  new AgentSupervisor({
    log: entry.harness.log,
    threads: entry.harness.threads,
    ids: entry.harness.ids,
    clock: entry.harness.clock,
    agentTypes: [agentTypeNamed({ name: 'explore' }), agentTypeNamed({ name: 'builder' })],
    runners: nothingRuns,
    launchDirectory: '/launch',
  })

async function spawnAndFinish(entry: OpenedSupervisor): Promise<ThreadId> {
  const outcome = await entry.supervisor.spawn({
    threadId: entry.parent,
    agentType: 'builder',
    brief: 'write the thing',
    intent: 'write the thing',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  await settled()
  entry.runners.started[0]?.settle(finished())
  await settled()
  await deliverNotices(entry)
  return outcome.snapshot.agentId
}

describe('a sub-agent whose delegation a rewind deletes', () => {
  it('deletes the child thread along with the rows that recorded it', async () => {
    const entry = await openAndTrack()
    const agentId = await completedDelegation(entry)

    expect(await rewindToStart(entry)).toMatchObject({ ok: true })

    expect(await entry.harness.threads.find({ threadId: agentId })).toBeUndefined()
  })

  it('reports nothing lost when a fresh process opens the conversation again', async () => {
    const entry = await openAndTrack()
    await completedDelegation(entry)
    await rewindToStart(entry)

    const recovered = await freshSupervisor(entry).recordLostAgents({ threadId: entry.parent })

    expect(recovered.settled).toHaveLength(0)
    expect(recovered.unlogged).toHaveLength(0)
  })

  it('keeps a child whose spawn sits at the rewind target, and keeps recording for it', async () => {
    const entry = await openAndTrack()
    const kept = await openChildThread({
      threads: entry.harness.threads,
      log: entry.harness.log,
      ids: entry.harness.ids,
      spawnedBy: entry.parent,
      agentType: agentTypeNamed({ name: 'explore' }),
      brief: 'find the callers',
      intent: 'find the callers',
    })
    const cut = await completedDelegation(entry)

    await rewindThread({
      log: entry.harness.log,
      threads: entry.harness.threads,
      agents: entry.supervisor,
      threadId: entry.parent,
      toSeq: 1,
    })

    expect(await entry.harness.threads.find({ threadId: kept })).toBeDefined()
    expect(await entry.harness.threads.find({ threadId: cut })).toBeUndefined()

    const recovered = await entry.supervisor.recordLostAgents({ threadId: entry.parent })
    expect(recovered.unlogged).toHaveLength(0)
    expect(recovered.settled.map((child) => child.agentId)).toEqual([kept])
  })

  it('leaves a child the parent never recorded alone, and still reports it', async () => {
    const entry = await openAndTrack()
    const { thread: orphan } = await entry.harness.threads.createWithFirstEvents({
      runId: entry.harness.ids.nextRunId(),
      drafts: [{ type: 'user-said', text: 'find the callers', via: EMessageOrigin.ParentAgent }],
      title: 'explore: find the callers',
      agent: { spawnedBy: entry.parent, type: 'explore' },
    })
    await completedDelegation(entry)

    await rewindToStart(entry)

    expect(await entry.harness.threads.find({ threadId: orphan.id })).toBeDefined()
    const recovered = await entry.supervisor.recordLostAgents({ threadId: entry.parent })
    expect(recovered.unlogged.map((child) => child.agentId)).toEqual([orphan.id])
  })

  it('detaches a child a fork still reads from, rather than deleting it or reporting it lost', async () => {
    const entry = await openAndTrack()
    const agentId = await completedDelegation(entry)
    const fork = await entry.harness.threads.fork({
      from: agentId,
      seq: 0,
      mode: EForkMode.Copy,
    })

    expect(await rewindToStart(entry)).toMatchObject({ ok: true })

    const survived = await entry.harness.threads.find({ threadId: agentId })
    expect(survived).toBeDefined()
    expect(survived?.agent).toBeUndefined()
    expect(await entry.harness.threads.find({ threadId: fork.id })).toBeDefined()

    const recovered = await entry.supervisor.recordLostAgents({ threadId: entry.parent })
    expect(recovered.unlogged).toHaveLength(0)
  })

  it('forgets the removed child in memory, so the roster goes with the rows', async () => {
    const entry = await openAndTrack()
    const agentId = await spawnAndFinish(entry)

    expect(await rewindToStart(entry)).toMatchObject({ ok: true })

    expect(entry.supervisor.list({ threadId: entry.parent })).toHaveLength(0)
    expect(await entry.harness.threads.find({ threadId: agentId })).toBeUndefined()
  })

  it('drops the ending a removed child queued, so nothing records it after the rows are gone', async () => {
    const entry = await openAndTrack()
    const agentId = await spawnAndFinish(entry)

    const again = await entry.supervisor.say({
      agentId,
      threadId: entry.parent,
      text: 'one more pass',
    })
    if (!again.ok) throw new Error(again.reason)
    await settled()
    entry.runners.started[1]?.settle(finished())
    await settled()

    expect(entry.supervisor.pendingNotices({ threadId: entry.parent })).toHaveLength(1)
    expect(await rewindToStart(entry)).toMatchObject({ ok: true })

    expect(entry.supervisor.pendingNotices({ threadId: entry.parent })).toHaveLength(0)
    expect(entry.supervisor.drainNotifications({ threadId: entry.parent })).toHaveLength(0)
  })

  it('stops a child that started stepping again before its thread is deleted', async () => {
    const entry = await openAndTrack()
    const agentId = await spawnAndFinish(entry)

    const again = await entry.supervisor.resume({
      agentId,
      threadId: entry.parent,
    })
    if (!again.ok) throw new Error(again.reason)
    await settled()

    const running = entry.runners.started[1]
    if (running === undefined) throw new Error('the child did not start stepping again')

    expect(await rewindToStart(entry)).toMatchObject({ ok: true })

    expect(running.signal.aborted).toBe(true)
    expect(entry.supervisor.list({ threadId: entry.parent })).toHaveLength(0)

    running.settle(finished())
    await settled()
    expect(entry.supervisor.drainNotifications({ threadId: entry.parent })).toHaveLength(0)

    await entry.supervisor.closeAll()
  })
})

describe('a sub-agent whose delegation a destructive summarise deletes', () => {
  it('removes the child the same way a rewind does', async () => {
    const entry = await openAndTrack()
    const agentId = await completedDelegation(entry)
    await entry.harness.log.append({
      threadId: entry.parent,
      runId: entry.harness.ids.nextRunId(),
      drafts: [{ type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] }],
    })

    const outcome = await compactThread({
      log: entry.harness.log,
      threads: entry.harness.threads,
      agents: entry.supervisor,
      threadId: entry.parent,
      anchor: ECompactionAnchor.Prefix,
      seq: 2,
      summarise: async () => 'delegated and got an answer',
      destructive: true,
    })

    expect(outcome.ok).toBe(true)
    expect(await entry.harness.threads.find({ threadId: agentId })).toBeUndefined()

    const recovered = await freshSupervisor(entry).recordLostAgents({ threadId: entry.parent })
    expect(recovered.unlogged).toHaveLength(0)
  })
})
