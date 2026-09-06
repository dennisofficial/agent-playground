import { describe, expect, it } from 'bun:test'

import {
  EToolEffect,
  toCallId,
  toThreadId,
  type ToolCall,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { OutsideProjectHook } from '../outside-project'

const NEVER_ABORTED = new AbortController().signal

const PROJECT = '/Users/dennis/Developer/atlas/.atlas/worktrees/highlight-loop'

const hook = new OutsideProjectHook()

const callOf = (args: { name: string; input: unknown; effect?: EToolEffect | undefined }): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input,
  effect: args.effect ?? EToolEffect.Write,
  threadId: toThreadId('thread-1'),
})

const OK: ToolOutcome = { ok: true, output: {}, modelText: 'ok' }

const run = (args: { name?: string; input?: unknown; result?: ToolOutcome; effect?: EToolEffect }) =>
  hook.run({
    call: callOf({ name: args.name ?? 'write', input: args.input ?? {}, effect: args.effect }),
    result: args.result ?? OK,
    projectDirectory: PROJECT,
    signal: NEVER_ABORTED,
  })

describe('OutsideProjectHook', () => {
  it('nudges when a write lands in a sibling worktree', async () => {
    const outcome = await run({
      input: {
        path: '/Users/dennis/Developer/atlas/.atlas/worktrees/cheap-shimmer/apps/tui/src/ui/x.ts',
      },
    })

    expect(outcome.additionalContext).toContain('cheap-shimmer')
    expect(outcome.additionalContext).toContain(PROJECT)
    expect(outcome.additionalContext).toContain('enter_worktree')
  })

  it('stays silent for a write inside the project directory', async () => {
    const outcome = await run({ input: { path: `${PROJECT}/apps/tui/src/main.tsx` } })

    expect(outcome).toEqual({})
  })

  it('stays silent for atlas home, home dotfiles and temp roots', async () => {
    for (const path of [
      '/Users/dennis/.atlas/memory/note.md',
      '/Users/dennis/.zshrc',
      '/tmp/scratch.ts',
    ]) {
      expect(await run({ input: { path } })).toEqual({})
    }
  })

  it('nudges on edit and multi_edit too, not only write', async () => {
    for (const name of ['edit', 'multi_edit']) {
      const outcome = await run({ name, input: { path: '/Users/dennis/Developer/comp-v3/x.ts' } })

      expect(outcome.additionalContext).toContain('/Users/dennis/Developer/comp-v3/x.ts')
    }
  })

  it('ignores effects that do not write, even when the call names a path', async () => {
    for (const effect of [EToolEffect.Read, EToolEffect.Destructive]) {
      const outcome = await run({
        name: 'read',
        input: { path: '/Users/dennis/Developer/comp-v3/x.ts' },
        effect,
      })

      expect(outcome).toEqual({})
    }
  })

  it('ignores a write-effect call whose input carries no path, like agent_spawn', async () => {
    const outcome = await run({ name: 'agent_spawn', input: { brief: 'look around' } })

    expect(outcome).toEqual({})
  })

  it('ignores a failed write', async () => {
    const outcome = await run({
      input: { path: '/Users/dennis/Developer/comp-v3/x.ts' },
      result: { ok: false, reason: 'no' },
    })

    expect(outcome).toEqual({})
  })

  it('ignores input without a string path', async () => {
    expect(await run({ input: {} })).toEqual({})
    expect(await run({ input: { path: 42 } })).toEqual({})
    expect(await run({ input: 'nope' })).toEqual({})
  })
})
