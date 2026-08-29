import { describe, expect, it } from 'bun:test'

import {
  EToolEffect,
  sessionDirectoryOf,
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
  type ToolCall,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { TrackSessionDirectoryHook } from '../track-session-directory'

const PROJECT = '/Users/dev/project'

const log = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_draft, index) => ({
      id: toEventId(`event-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-fixture'),
      runId: toRunId('run-fixture'),
      depth: 0,
      at: '2026-01-01T00:00:00.000Z',
    })),
  })

const call: ToolCall = { callId: toCallId('call-1'), name: 'bash', input: {}, effect: EToolEffect.Write }

const ranBash = (output: unknown): ToolOutcome => ({ ok: true, output, modelText: 'done' })

const draftsFor = async (output: unknown): Promise<readonly EventDraft[]> =>
  (await new TrackSessionDirectoryHook().run({ call, result: ranBash(output) })).drafts ?? []

describe('what the hook records about the session directory', () => {
  it('records nothing at all when the command did not move the shell', async () => {
    expect(await draftsFor({ stdout: 'ok' })).toEqual([])
  })

  it('records the move as one event and nothing else', async () => {
    expect(await draftsFor({ sessionDirectory: `${PROJECT}/apps/tui` })).toEqual([
      { type: 'cwd-changed', path: `${PROJECT}/apps/tui` },
    ])
  })

  it('records nothing when the command failed, however the shell ended up', async () => {
    const failed: ToolOutcome = { ok: false, reason: 'the command exited 1' }

    expect(await new TrackSessionDirectoryHook().run({ call, result: failed })).toEqual({})
  })
})

describe('what the recorded events project to', () => {
  it('leaves the latest move as the session directory, not the first', async () => {
    const first = await draftsFor({ sessionDirectory: `${PROJECT}/apps` })
    const second = await draftsFor({ sessionDirectory: `${PROJECT}/packages` })

    const events = log([...first, ...second])

    expect(sessionDirectoryOf({ events, projectDirectory: PROJECT })).toBe(`${PROJECT}/packages`)
  })

  it('projects back to the project directory once a move returns there', async () => {
    const away = await draftsFor({ sessionDirectory: `${PROJECT}/apps` })
    const back = await draftsFor({ sessionDirectory: PROJECT })

    const events = log([...away, ...back])

    expect(sessionDirectoryOf({ events, projectDirectory: PROJECT })).toBe(PROJECT)
  })
})
