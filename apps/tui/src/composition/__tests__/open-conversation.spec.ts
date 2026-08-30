import {
  toThreadId,
  toEventId,
  toRunId,
  type Event,
  type WorkspaceIdentity,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { ETurnStatus, type TurnSpend } from '@dltech/atlas-harness'

import { EOpenMode } from '../config'
import { openConversation, type OpenOutcome, type OpenedConversation } from '../open-conversation'
import { fakeThreadStore, fakeEventLog, fakeLedger, FAKE_WORKSPACE } from './fake-backend'

const YESTERDAY = toThreadId('yesterday')

const HERE: WorkspaceIdentity = { workspace: FAKE_WORKSPACE, repo: null }

const spent: TurnSpend = {
  threadId: YESTERDAY,
  runId: toRunId('r1'),
  status: ETurnStatus.Completed,
  providerId: 'anthropic',
  modelId: 'claude-opus-5',
  steps: 1,
  inputTokens: 1_000,
  outputTokens: 222,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  startedAt: '2026-08-24T00:00:00.000Z',
  endedAt: '2026-08-24T00:00:03.000Z',
  durationMs: 3_000,
}

const said = (text: string): Event => ({
  type: 'user-said',
  text,
  id: toEventId('e1'),
  seq: 1,
  threadId: YESTERDAY,
  runId: toRunId('r1'),
  depth: 0,
  at: '2026-08-24T00:00:00.000Z',
})

const opened = (outcome: OpenOutcome): OpenedConversation => {
  if (!outcome.ok) throw new Error(`expected an opened conversation, got: ${outcome.reason}`)
  return outcome.conversation
}

describe('which conversation the app opens on', () => {
  it('starts a new one by default, without touching the last', async () => {
    const threads = fakeThreadStore({ existing: [YESTERDAY] })

    const outcome = await openConversation({
      threads,
      log: fakeEventLog([said('do not pollute this')]),
      ledger: fakeLedger({ spent: [spent] }),
      workspace: HERE,
      open: { mode: EOpenMode.New },
    })

    expect(opened(outcome).threadId).not.toBe(YESTERDAY)
    expect(opened(outcome).events).toEqual([])
    expect(threads.created).toBe(1)
  })

  it('continues the most recent one, with everything it already held', async () => {
    const threads = fakeThreadStore({ existing: [toThreadId('older'), YESTERDAY] })

    const outcome = await openConversation({
      threads,
      log: fakeEventLog([said('carry this on')]),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Continue },
    })

    expect(opened(outcome).threadId).toBe(YESTERDAY)
    expect(opened(outcome).events).toHaveLength(1)
    expect(threads.created).toBe(0)
  })

  it('carries what its turns already spent, so the lines are drawn on the first frame', async () => {
    const threads = fakeThreadStore({ existing: [YESTERDAY] })

    const outcome = await openConversation({
      threads,
      log: fakeEventLog([said('carry this on')]),
      ledger: fakeLedger({ spent: [spent] }),
      workspace: HERE,
      open: { mode: EOpenMode.Continue },
    })

    expect(opened(outcome).turns).toEqual([spent])
  })

  it('starts one when there is none to continue, so first run is not an error state', async () => {
    const threads = fakeThreadStore()

    const outcome = await openConversation({
      threads,
      log: fakeEventLog(),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Continue },
    })

    expect(threads.created).toBe(1)
    expect(opened(outcome).events).toEqual([])
  })

  it('does not continue a conversation belonging to another workspace', async () => {
    const threads = fakeThreadStore({ existing: [YESTERDAY], workspace: '/elsewhere' })

    const outcome = await openConversation({
      threads,
      log: fakeEventLog([said('another project')]),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Continue },
    })

    expect(opened(outcome).threadId).not.toBe(YESTERDAY)
    expect(opened(outcome).events).toEqual([])
    expect(threads.created).toBe(1)
  })

  it('resumes the conversation it was handed by id', async () => {
    const threads = fakeThreadStore({ existing: [toThreadId('older'), YESTERDAY] })

    const outcome = await openConversation({
      threads,
      log: fakeEventLog([said('pick this one')]),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Resume, threadId: 'older' },
    })

    expect(opened(outcome).threadId).toBe(toThreadId('older'))
    expect(threads.created).toBe(0)
  })

  it('refuses an id that does not exist rather than opening something else', async () => {
    const outcome = await openConversation({
      threads: fakeThreadStore({ existing: [YESTERDAY] }),
      log: fakeEventLog(),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Resume, threadId: 'never-was' },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain('never-was')
  })

  it('refuses an id belonging to another workspace, however real it is', async () => {
    const outcome = await openConversation({
      threads: fakeThreadStore({ existing: [YESTERDAY], workspace: '/elsewhere' }),
      log: fakeEventLog(),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Resume, threadId: YESTERDAY },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain(FAKE_WORKSPACE)
  })
  it('resumes by the name the exit line printed, not only by the id', async () => {
    const threads = fakeThreadStore({
      existing: [toThreadId('older'), YESTERDAY],
      titles: { [YESTERDAY]: 'Atlas Daily Driver Setup' },
    })

    const outcome = await openConversation({
      threads,
      log: fakeEventLog([said('the one with a name')]),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Resume, threadId: 'atlas-daily-driver-setup' },
    })

    expect(opened(outcome).threadId).toBe(YESTERDAY)
    expect(threads.created).toBe(0)
  })

  it('takes the title as it was written, without asking for the slug', async () => {
    const outcome = await openConversation({
      threads: fakeThreadStore({
        existing: [YESTERDAY],
        titles: { [YESTERDAY]: 'Atlas Daily Driver Setup' },
      }),
      log: fakeEventLog([said('the one with a name')]),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Resume, threadId: 'Atlas Daily Driver Setup' },
    })

    expect(opened(outcome).threadId).toBe(YESTERDAY)
  })

  it('resumes one recorded before conversations were attributed to a workspace', async () => {
    const threads = fakeThreadStore({ existing: [YESTERDAY], workspace: null })

    const outcome = await openConversation({
      threads,
      log: fakeEventLog([said('from before the attribution')]),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Resume, threadId: YESTERDAY },
    })

    expect(opened(outcome).threadId).toBe(YESTERDAY)
    expect(opened(outcome).events).toHaveLength(1)
  })

  it('files an unattributed conversation under this workspace, so it is never lost twice', async () => {
    const threads = fakeThreadStore({ existing: [YESTERDAY], workspace: null })

    await openConversation({
      threads,
      log: fakeEventLog([said('from before the attribution')]),
      ledger: fakeLedger(),
      workspace: HERE,
      open: { mode: EOpenMode.Resume, threadId: YESTERDAY },
    })

    expect(await threads.mostRecent({ workspace: FAKE_WORKSPACE })).toMatchObject({
      id: YESTERDAY,
    })
  })
})
