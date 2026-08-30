import { afterEach, describe, expect, it } from 'bun:test'

import {
  EForkMode,
  EForkRefusal,
  ERewindRefusal,
  toCallId,
  toRunId,
  type ThreadId,
  type EventDraft,
} from '@dltech/atlas-core'

import { forkConversation } from '../guarded-fork'
import { rewindThread } from '../rewind'
import { openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')

const said = (text: string): EventDraft => ({ type: 'user-said', text })
const replied = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})
const called: EventDraft = {
  type: 'tool-called',
  callId: toCallId('call-1'),
  name: 'bash',
  input: { command: 'ls' },
  ordinal: 0,
}
const resulted: EventDraft = {
  type: 'tool-result',
  callId: toCallId('call-1'),
  name: 'bash',
  output: { ok: true },
}

const openThread = async (drafts: readonly EventDraft[]): Promise<ThreadId> => {
  fixture = await openStoreFixture()
  const thread = await fixture.threads.create({ title: 'work', workspace: '/work' })
  await fixture.log.append({ threadId: thread.id, runId, drafts })
  return thread.id
}

const forkAt = (args: { threadId: ThreadId; seq: number; mode: EForkMode }) =>
  forkConversation({
    log: fixture.log,
    threads: fixture.threads,
    threadId: args.threadId,
    seq: args.seq,
    mode: args.mode,
  })

afterEach(async () => {
  await fixture.close()
})

describe('forkConversation', () => {
  it('refuses a fork that would hand the new thread an unsettled call to run again', async () => {
    const threadId = await openThread([said('clean the build'), called])

    const forked = await forkAt({ threadId, seq: 2, mode: EForkMode.Copy })

    expect(forked.ok).toBe(false)
    expect(forked.ok === false && forked.refusal).toBe(EForkRefusal.UnsettledToolCall)
  })

  it('creates no thread when the guard refuses', async () => {
    const threadId = await openThread([said('clean the build'), called])
    const before = await fixture.threads.list({ workspace: '/work' })

    await forkAt({ threadId, seq: 2, mode: EForkMode.Copy })

    expect(await fixture.threads.list({ workspace: '/work' })).toEqual(before)
  })

  it('copies the inherited prefix into a copy fork and leaves the parent whole', async () => {
    const threadId = await openThread([said('clean the build'), called, resulted, replied('done')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Copy })
    if (!forked.ok) throw new Error(forked.reason)

    expect(forked.inherited).toBe(3)
    expect((await fixture.log.readOwn({ threadId: forked.thread.id })).map((e) => e.seq)).toEqual([1, 2, 3])
    expect((await fixture.log.read({ threadId })).length).toBe(4)
  })

  it('copies nothing into a reference fork but reads the inherited prefix through it', async () => {
    const threadId = await openThread([said('clean the build'), called, resulted, replied('done')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)

    expect(await fixture.log.readOwn({ threadId: forked.thread.id })).toEqual([])
    expect((await fixture.log.read({ threadId: forked.thread.id })).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('continues the sequence above the fork point on both kinds of fork', async () => {
    const threadId = await openThread([said('clean the build'), called, resulted, replied('done')])

    for (const mode of [EForkMode.Copy, EForkMode.Reference]) {
      const forked = await forkAt({ threadId, seq: 3, mode })
      if (!forked.ok) throw new Error(forked.reason)

      const [appended] = await fixture.log.append({
        threadId: forked.thread.id,
        runId,
        drafts: [said('and now this')],
      })

      expect(appended?.seq).toBe(4)
      expect((await fixture.log.read({ threadId: forked.thread.id })).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    }
  })

  it('leaves the parent untouched when the child is written to', async () => {
    const threadId = await openThread([said('clean the build'), replied('done')])

    const forked = await forkAt({ threadId, seq: 2, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)

    await fixture.log.append({ threadId: forked.thread.id, runId, drafts: [said('child only')] })

    expect((await fixture.log.readOwn({ threadId })).map((e) => e.seq)).toEqual([1, 2])
  })
})

const loadedClaudeMd: EventDraft = {
  type: 'context-loaded',
  slot: 'project-instructions',
  key: '/repo/CLAUDE.md',
  content: 'Never use as any.',
}

describe('loaded context across a reference fork', () => {
  it('reuses the parent row when the child re-offers unchanged content, so the inherited prefix stays byte-identical', async () => {
    const threadId = await openThread([loadedClaudeMd, said('build the parser'), replied('done')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)

    const [reoffered] = await fixture.log.append({
      threadId: forked.thread.id,
      runId,
      drafts: [loadedClaudeMd],
    })

    expect(reoffered?.seq).toBe(1)
    expect(await fixture.log.readOwn({ threadId: forked.thread.id })).toEqual([])
    expect((await fixture.log.read({ threadId: forked.thread.id })).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('appends a fresh row on the child when the content actually changed', async () => {
    const threadId = await openThread([loadedClaudeMd, said('build the parser')])

    const forked = await forkAt({ threadId, seq: 2, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)

    await fixture.log.append({
      threadId: forked.thread.id,
      runId,
      drafts: [{ ...loadedClaudeMd, content: 'Never use as any. Also no comments.' }],
    })

    expect((await fixture.log.readOwn({ threadId: forked.thread.id })).length).toBe(1)
  })
})

describe('rewinding across a fork boundary', () => {
  it('refuses to rewind a reference fork into the prefix it inherited rather than owns', async () => {
    const threadId = await openThread([said('one'), replied('two'), said('three')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)
    await fixture.log.append({ threadId: forked.thread.id, runId, drafts: [said('four')] })

    const rewound = await rewindThread({
      log: fixture.log,
      threads: fixture.threads,
      threadId: forked.thread.id,
      toSeq: 1,
    })

    expect(rewound.ok).toBe(false)
    expect(rewound.ok === false && rewound.refusal).toBe(ERewindRefusal.BelowInheritedPrefix)
  })

  it('leaves the sequence space intact, so a later append cannot collide with an inherited row', async () => {
    const threadId = await openThread([said('one'), replied('two'), said('three')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)
    await fixture.log.append({ threadId: forked.thread.id, runId, drafts: [said('four')] })

    await rewindThread({
      log: fixture.log,
      threads: fixture.threads,
      threadId: forked.thread.id,
      toSeq: 1,
    })
    await fixture.log.append({ threadId: forked.thread.id, runId, drafts: [said('five')] })

    const seqs = (await fixture.log.read({ threadId: forked.thread.id })).map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('still rewinds a reference fork down to its own first sequence', async () => {
    const threadId = await openThread([said('one'), replied('two'), said('three')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)
    await fixture.log.append({ threadId: forked.thread.id, runId, drafts: [said('four')] })

    const rewound = await rewindThread({
      log: fixture.log,
      threads: fixture.threads,
      threadId: forked.thread.id,
      toSeq: 3,
    })

    expect(rewound).toEqual({ ok: true, discarded: 1 })
  })

  it('lets a copy fork rewind below the fork point, because it owns every row it holds', async () => {
    const threadId = await openThread([said('one'), replied('two'), said('three')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Copy })
    if (!forked.ok) throw new Error(forked.reason)

    const rewound = await rewindThread({
      log: fixture.log,
      threads: fixture.threads,
      threadId: forked.thread.id,
      toSeq: 1,
    })

    expect(rewound).toEqual({ ok: true, discarded: 2 })
    expect((await fixture.log.readOwn({ threadId })).length).toBe(3)
  })

  it('counts only the rows it deleted, not the inherited ones it left alone', async () => {
    const threadId = await openThread([said('one'), replied('two'), said('three')])

    const forked = await forkAt({ threadId, seq: 3, mode: EForkMode.Reference })
    if (!forked.ok) throw new Error(forked.reason)
    await fixture.log.append({ threadId: forked.thread.id, runId, drafts: [said('four'), said('five')] })

    const rewound = await rewindThread({
      log: fixture.log,
      threads: fixture.threads,
      threadId: forked.thread.id,
      toSeq: 4,
    })

    expect(rewound).toEqual({ ok: true, discarded: 1 })
  })
})
