import { describe, expect, it } from 'bun:test'

import {
  EBeforeToolDecision,
  EToolEffect,
  toCallId,
  toThreadId,
  type ClockPort,
  type ToolCall,
} from '@dltech/atlas-core'

import { localDayOf } from '../../time/local-day'
import { StampMemoryHook } from '../stamp-memory'

const MEMORY = '/home/dev/.atlas/memory'
const PROJECT = '/home/dev/.atlas/projects/-a/memory'

const clockAt = (instant: string): ClockPort => ({ now: () => instant })

const hook = (instant = '2026-09-01T18:00:00.000Z'): StampMemoryHook =>
  new StampMemoryHook({ directories: [MEMORY, PROJECT], clock: clockAt(instant) })

const call = (args: { name?: string; input: unknown }): ToolCall => ({
  callId: toCallId('c1'),
  threadId: toThreadId('t1'),
  name: args.name ?? 'write',
  input: args.input,
  effect: EToolEffect.Write,
})

const inputOf = async (args: { name?: string; input: unknown }, instant?: string) => {
  const outcome = await hook(instant).run({
    call: call(args),
    projectDirectory: '/home/dev/code',
    events: [],
    signal: new AbortController().signal,
  })
  expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  return outcome.decision === EBeforeToolDecision.Allow ? outcome.input : undefined
}

const body = (front: string): string => `---\n${front}\n---\n\nThe claim.\n`

describe('StampMemoryHook', () => {
  it('stamps a memory the model wrote without a date', async () => {
    const input = await inputOf({
      input: { path: `${MEMORY}/a.md`, content: body('name: a\ntype: project') },
    })

    expect(input).toEqual({
      path: `${MEMORY}/a.md`,
      content: `---\nname: a\ntype: project\nrecorded: 2026-09-01\n---\n\nThe claim.\n`,
    })
  })

  it('overwrites a date the model guessed, so the clock is the only authority', async () => {
    const input = await inputOf({
      input: { path: `${PROJECT}/b.md`, content: body('name: b\nrecorded: 2026-08-19') },
    })

    expect(input).toMatchObject({ content: expect.stringContaining('recorded: 2026-09-01') })
    expect(input).toMatchObject({ content: expect.not.stringContaining('2026-08-19') })
  })

  it('stamps the local day, which is not always the one the instant starts with', async () => {
    const instant = '2026-09-02T02:00:00.000Z'
    const input = await inputOf(
      { input: { path: `${MEMORY}/a.md`, content: body('name: a') } },
      instant,
    )

    expect(input).toMatchObject({
      content: expect.stringContaining(`recorded: ${localDayOf(instant)}`),
    })
  })

  it('leaves a write outside the memory directories untouched', async () => {
    const content = body('name: a')
    const input = await inputOf({ input: { path: '/home/dev/code/README.md', content } })

    expect(input).toEqual({ path: '/home/dev/code/README.md', content })
  })

  it('leaves the index alone, because it carries no frontmatter', async () => {
    const content = '- [A](a.md) — the hook\n'
    const input = await inputOf({ input: { path: `${MEMORY}/MEMORY.md`, content } })

    expect(input).toEqual({ path: `${MEMORY}/MEMORY.md`, content })
  })

  it('leaves an edit alone, since it cannot see the whole resulting file', async () => {
    const input = { path: `${MEMORY}/a.md`, oldString: 'x', newString: 'y' }

    expect(await inputOf({ name: 'edit', input })).toEqual(input)
  })

  it('passes an unparseable input through rather than failing the call', async () => {
    expect(await inputOf({ input: { path: 7 } })).toEqual({ path: 7 })
  })
})
