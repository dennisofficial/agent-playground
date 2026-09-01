import { afterEach, describe, expect, it } from 'bun:test'

import { EMessageOrigin, saidBy, type ThreadId } from '@dltech/atlas-core'

import { steerDrafts } from '../child-runner'
import { finished, openSupervisor, settled, type OpenedSupervisor } from './fixtures'

const opened: OpenedSupervisor[] = []

afterEach(async () => {
  for (const entry of opened.splice(0)) await entry.close()
})

async function childOf(open: OpenedSupervisor): Promise<ThreadId> {
  const outcome = await open.supervisor.spawn({
    threadId: open.parent,
    agentType: 'builder',
    brief: 'write the thing',
    intent: 'write the thing',
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  await settled()

  return outcome.snapshot.agentId
}

const voicesIn = async (open: OpenedSupervisor, threadId: ThreadId) =>
  (await open.harness.log.readOwn({ threadId }))
    .filter((event) => event.type === 'user-said')
    .map(saidBy)

describe('whose voice reaches a child', () => {
  it('marks the brief as the parent, because the parent wrote it', async () => {
    const open = await openSupervisor()
    opened.push(open)

    const agentId = await childOf(open)

    expect(await voicesIn(open, agentId)).toEqual([EMessageOrigin.ParentAgent])

    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()
  })

  it('marks a steer the parent sent to a settled child as the parent', async () => {
    const open = await openSupervisor()
    opened.push(open)
    const agentId = await childOf(open)
    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()

    await open.supervisor.say({ agentId, threadId: open.parent, text: 'look at the tests too' })
    await settled()

    expect(await voicesIn(open, agentId)).toEqual([
      EMessageOrigin.ParentAgent,
      EMessageOrigin.ParentAgent,
    ])

    open.runners.started[1]?.settle(finished())
    await open.supervisor.closeAll()
  })

  it('reads a row nobody attributed as the operator, so old rows keep their meaning', async () => {
    const open = await openSupervisor()
    opened.push(open)
    const agentId = await childOf(open)

    await open.harness.log.append({
      threadId: agentId,
      runId: open.harness.ids.nextRunId(),
      drafts: [{ type: 'user-said', text: 'actually, stop reading and summarise' }],
    })

    expect(await voicesIn(open, agentId)).toEqual([
      EMessageOrigin.ParentAgent,
      EMessageOrigin.Operator,
    ])

    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()
  })
})

const SHOT = {
  path: '/tmp/atlas/shot.png',
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
  width: 560,
  height: 280,
}

const imagesIn = async (open: OpenedSupervisor, threadId: ThreadId) =>
  (await open.harness.log.readOwn({ threadId }))
    .flatMap((event) => (event.type === 'user-said' ? [event.images ?? []] : []))
    .flat()

describe('a picture the operator hands a child', () => {
  it('reaches it as pixels, not as a path the child has to go and read', async () => {
    const open = await openSupervisor()
    opened.push(open)
    const agentId = await childOf(open)
    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()

    await open.supervisor.say({
      agentId,
      threadId: open.parent,
      text: 'why is this broken',
      images: [SHOT],
    })
    await settled()

    expect(await imagesIn(open, agentId)).toEqual([SHOT])

    open.runners.started[1]?.settle(finished())
    await open.supervisor.closeAll()
  })

  it('waits in the steering queue with its pixels when the child is mid-step', async () => {
    const open = await openSupervisor()
    opened.push(open)
    const agentId = await childOf(open)

    await open.supervisor.say({
      agentId,
      threadId: open.parent,
      text: 'look at this instead',
      images: [SHOT],
    })

    expect(open.runners.started[0]?.request.steering()).toEqual([
      { text: 'look at this instead', images: [SHOT] },
    ])

    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()
  })

  it('leaves a wordless steer without an images key rather than an empty one', async () => {
    const open = await openSupervisor()
    opened.push(open)
    const agentId = await childOf(open)
    open.runners.started[0]?.settle(finished())
    await open.supervisor.closeAll()

    await open.supervisor.say({ agentId, threadId: open.parent, text: 'carry on', images: [] })
    await settled()

    const said = (await open.harness.log.readOwn({ threadId: agentId })).filter(
      (event) => event.type === 'user-said',
    )

    expect(said.at(-1)).not.toHaveProperty('images')

    open.runners.started[1]?.settle(finished())
    await open.supervisor.closeAll()
  })
})

describe('a steer queued while the child was stepping', () => {
  it('reaches the child in the parent voice, the same as one it was handed idle', () => {
    expect(steerDrafts([{ text: 'stop reading' }, { text: 'summarise' }])).toEqual([
      { type: 'user-said', text: 'stop reading', via: EMessageOrigin.ParentAgent },
      { type: 'user-said', text: 'summarise', via: EMessageOrigin.ParentAgent },
    ])
  })
})

describe('steerDrafts', () => {
  it('carries a queued picture through to the draft it builds', () => {
    expect(steerDrafts([{ text: 'this one', images: [SHOT] }])).toEqual([
      { type: 'user-said', text: 'this one', via: EMessageOrigin.ParentAgent, images: [SHOT] },
    ])
  })

  it('omits the key entirely when a steer carried no picture', () => {
    expect(steerDrafts([{ text: 'plain' }])).toEqual([
      { type: 'user-said', text: 'plain', via: EMessageOrigin.ParentAgent },
    ])
  })
})
