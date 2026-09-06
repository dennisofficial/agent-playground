import { afterEach, describe, expect, it } from 'bun:test'

import {
  EClassifierMode,
  EConsultation,
  ECompactionAnchor,
  EGrantScope,
  EJudgment,
  ERiskDimension,
  ETriage,
  toRunId,
  type Event,
  type EventDraft,
  type ThreadId,
} from '@dltech/atlas-core'

import { compactThread } from '../../store/compact'
import { rewindThread } from '../../store/rewind'
import { openStoreFixture, type StoreFixture } from '../../store/__tests__/harness'
import {
  callTo,
  classify,
  factsInAWorktree,
  hookOver,
  judgedIn,
  policyIn,
  RecordingFacts,
  SIBLING,
} from './fixtures'

let fixture: StoreFixture

const runId = toRunId('run-1')

const REMOVAL = `git worktree remove --force ${SIBLING}`

const call = callTo({ name: 'bash', input: { command: REMOVAL } })

const consulted: string[] = []

const weigh = (events: readonly Event[]) =>
  classify({
    hook: hookOver({
      facts: new RecordingFacts(factsInAWorktree({ siblingChangedCount: 0 })),
      policy: policyIn(EClassifierMode.Nudge),
      judge: {
        consult: async () => {
          consulted.push(REMOVAL)
          return {
            kind: EConsultation.Judged,
            verdict: { judgment: EJudgment.Check, reason: 'the sibling is not ours to remove' },
            elapsedMs: 4,
          }
        },
      },
    }),
    call,
    events,
  })

const grantsFor = async (events: readonly Event[]): Promise<readonly EventDraft[]> => {
  const offers = judgedIn(await weigh(events)).grantables ?? []

  return offers.map((offer, index) => ({
    type: 'permission-granted',
    grantId: `grant:${call.callId}:${String(index)}`,
    dimensions: offer.dimensions,
    scope: EGrantScope.Thread,
    subject: offer.subject,
    reason: 'the operator chose to stop being asked about this',
  }))
}

const openThread = async (drafts: readonly EventDraft[]): Promise<ThreadId> => {
  fixture = await openStoreFixture()
  const thread = await fixture.threads.create({ title: 'clean up the merged worktrees' })
  await fixture.log.append({ threadId: thread.id, runId, drafts })
  return thread.id
}

const append = (args: { threadId: ThreadId; drafts: readonly EventDraft[] }) =>
  fixture.log.append({ threadId: args.threadId, runId, drafts: args.drafts })

const readBack = (threadId: ThreadId) => fixture.log.read({ threadId })

const said: EventDraft = { type: 'user-said', text: 'clean up the merged worktrees' }

const replied: EventDraft = {
  type: 'assistant-said',
  parts: [{ type: 'text', text: 'on it' }],
}

afterEach(async () => {
  consulted.length = 0
  await fixture.close()
})

describe('a permission the operator gave once', () => {
  it('is offered on the first pause, named by the worktree the call reached into', async () => {
    const threadId = await openThread([said])
    const judged = judgedIn(await weigh(await readBack(threadId)))

    expect(judged.triage).toBe(ETriage.Consult)
    expect(judged.grantables?.map((offer) => offer.subject)).toEqual(['worktree:eng-412-sidebar'])
  })

  it('reaches the drawer through the log rather than through the hook return', async () => {
    const threadId = await openThread([said])
    await append({ threadId, drafts: [judgedIn(await weigh(await readBack(threadId)))] })

    const stored = (await readBack(threadId)).find((event) => event.type === 'classifier-judged')

    expect(stored?.type === 'classifier-judged' ? stored.grantables : undefined).toEqual([
      {
        subject: 'worktree:eng-412-sidebar',
        dimensions: [ERiskDimension.Irreversibility, ERiskDimension.Reach],
      },
    ])
  })

  it('silences the identical call for the rest of the thread, reaching no judge', async () => {
    const threadId = await openThread([said])
    const granted = await grantsFor(await readBack(threadId))
    consulted.length = 0

    await append({ threadId, drafts: granted })
    const judged = judgedIn(await weigh(await readBack(threadId)))

    expect(judged.triage).toBe(ETriage.Clear)
    expect(judged.consulted).toBe(false)
    expect(consulted).toEqual([])
  })

  it('outlives the summary that buries the turn it was given in', async () => {
    const threadId = await openThread([said])
    const granted = await grantsFor(await readBack(threadId))
    await append({ threadId, drafts: [...granted, replied] })

    const compacted = await compactThread({
      log: fixture.log,
      threads: fixture.threads,
      agents: fixture.agents,
      threadId,
      anchor: ECompactionAnchor.Prefix,
      seq: 3,
      destructive: true,
      summarise: async () => 'the operator waived the sibling worktree',
    })
    expect(compacted.ok).toBe(true)

    const survived = await readBack(threadId)
    expect(survived.some((event) => event.type === 'user-said')).toBe(false)
    expect(survived.some((event) => event.type === 'permission-granted')).toBe(true)

    consulted.length = 0
    expect(judgedIn(await weigh(survived)).triage).toBe(ETriage.Clear)
    expect(consulted).toEqual([])
  })

  it('goes with the rewind that cuts below it, and the pause comes back', async () => {
    const threadId = await openThread([said, replied])
    const granted = await grantsFor(await readBack(threadId))
    await append({ threadId, drafts: granted })

    expect(judgedIn(await weigh(await readBack(threadId))).triage).toBe(ETriage.Clear)

    const rewound = await rewindThread({
      log: fixture.log,
      threads: fixture.threads,
      agents: fixture.agents,
      threadId,
      toSeq: 2,
    })
    expect(rewound.ok).toBe(true)

    const remaining = await readBack(threadId)
    expect(remaining.some((event) => event.type === 'permission-granted')).toBe(false)
    expect(judgedIn(await weigh(remaining)).triage).toBe(ETriage.Consult)
  })
})
