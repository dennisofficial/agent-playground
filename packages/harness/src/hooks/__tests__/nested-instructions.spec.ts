import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EContentAccess,
  EContextSlot,
  EInstructionFamily,
  EPathForm,
  EPathPresence,
  EToolEffect,
  toCallId,
  toThreadId,
  type ToolCall,
  type ToolDeclaration,
  type ToolOutcome,
} from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { NestedInstructionsHook, type NestedInstructionPlan } from '../nested-instructions'

const NEVER_ABORTED = new AbortController().signal

const FILE_TOOLS: readonly ToolDeclaration[] = [
  {
    name: 'read',
    description: 'reads a file',
    effect: EToolEffect.Read,
    inputSchema: z.object({ path: z.string() }),
    pathFields: [
      {
        field: 'path',
        presence: EPathPresence.Required,
        form: EPathForm.Absolute,
        content: EContentAccess.Reads,
      },
    ],
  },
  {
    name: 'bash',
    description: 'runs a shell command',
    effect: EToolEffect.Read,
    inputSchema: z.object({ command: z.string() }),
  },
]

let root: string

const write = ({ at, content }: { at: string; content: string }): string => {
  const path = join(root, at)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

const planOf = (args: { reload: boolean; enabled?: boolean }): NestedInstructionPlan => ({
  root,
  family: EInstructionFamily.Both,
  reload: args.reload,
  enabled: args.enabled ?? true,
})

const hookWith = (args: { reload: boolean; enabled?: boolean }): NestedInstructionsHook =>
  new NestedInstructionsHook({ source: () => planOf(args), tools: FILE_TOOLS })

const callOf = (args: {
  name?: string | undefined
  input: unknown
  thread?: string | undefined
}): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name ?? 'read',
  input: args.input,
  effect: EToolEffect.Read,
  threadId: toThreadId(args.thread ?? 'thread-1'),
})

const OK: ToolOutcome = { ok: true, output: {}, modelText: 'ok' }

const run = (
  hook: NestedInstructionsHook,
  args: {
    name?: string | undefined
    input: unknown
    result?: ToolOutcome | undefined
    cwd?: string | undefined
    thread?: string | undefined
  },
) =>
  hook.run({
    call: callOf({ name: args.name, input: args.input, thread: args.thread }),
    result: args.result ?? OK,
    projectDirectory: args.cwd ?? root,
    signal: NEVER_ABORTED,
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-nested-instructions-'))
})

describe('NestedInstructionsHook', () => {
  it('loads the instruction file above a touched file in a subtree off the descent', async () => {
    const path = write({ at: 'packages/core/AGENTS.md', content: 'package rules' })

    const outcome = await run(hookWith({ reload: true }), {
      cwd: join(root, 'apps/tui'),
      input: { path: join(root, 'packages/core/src/foo.ts') },
    })

    expect(outcome.drafts).toEqual([
      {
        type: 'context-loaded',
        slot: EContextSlot.NestedInstructions,
        key: path,
        content: 'package rules',
        triggeredBy: 'read',
      },
    ])
  })

  it('loads shallower nested files before deeper ones, so the deeper one wins', async () => {
    write({ at: 'packages/AGENTS.md', content: 'packages' })
    write({ at: 'packages/core/AGENTS.md', content: 'core' })

    const outcome = await run(hookWith({ reload: true }), {
      cwd: join(root, 'apps/tui'),
      input: { path: join(root, 'packages/core/src/foo.ts') },
    })

    expect(outcome.drafts?.map((draft) => draft.type === 'context-loaded' && draft.content)).toEqual(
      ['packages', 'core'],
    )
  })

  it('stays silent for a touched file the project descent already covers', async () => {
    write({ at: 'AGENTS.md', content: 'root rules' })

    const outcome = await run(hookWith({ reload: true }), {
      input: { path: join(root, 'AGENTS.md') },
    })

    expect(outcome).toEqual({})
  })

  it('stays silent when the tool call failed', async () => {
    write({ at: 'packages/core/AGENTS.md', content: 'package rules' })

    const outcome = await run(hookWith({ reload: true }), {
      input: { path: join(root, 'packages/core/src/foo.ts') },
      result: { ok: false, reason: 'not found' },
    })

    expect(outcome).toEqual({})
  })

  it('stays silent for a tool that declares no path fields', async () => {
    write({ at: 'packages/core/AGENTS.md', content: 'package rules' })

    const outcome = await run(hookWith({ reload: true }), {
      name: 'bash',
      input: { command: `ls ${join(root, 'packages/core')}` },
    })

    expect(outcome).toEqual({})
  })

  it('stays silent when project instructions are switched off', async () => {
    write({ at: 'packages/core/AGENTS.md', content: 'package rules' })

    const outcome = await run(hookWith({ reload: true, enabled: false }), {
      input: { path: join(root, 'packages/core/src/foo.ts') },
    })

    expect(outcome).toEqual({})
  })

  it('stays silent for a touched file outside the repository root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'atlas-nested-outside-'))
    writeFileSync(join(outside, 'AGENTS.md'), 'outside rules')

    const outcome = await run(hookWith({ reload: true }), {
      input: { path: join(outside, 'foo.ts') },
    })

    expect(outcome).toEqual({})
  })

  it('re-reads on every touch while reload is on, so an edit lands mid-conversation', async () => {
    const path = write({ at: 'packages/core/AGENTS.md', content: 'first' })
    const hook = hookWith({ reload: true })
    const input = { path: join(root, 'packages/core/src/foo.ts') }

    await run(hook, { input })
    writeFileSync(path, 'second')
    const again = await run(hook, { input })

    expect(again.drafts?.[0]).toMatchObject({ content: 'second' })
  })

  it('loads a directory once per thread while reload is off', async () => {
    const path = write({ at: 'packages/core/AGENTS.md', content: 'first' })
    const hook = hookWith({ reload: false })
    const input = { path: join(root, 'packages/core/src/foo.ts') }

    const first = await run(hook, { input })
    writeFileSync(path, 'second')
    const again = await run(hook, { input })

    expect(first.drafts?.[0]).toMatchObject({ content: 'first' })
    expect(again).toEqual({})
  })

  it('freezes per thread, not globally', async () => {
    write({ at: 'packages/core/AGENTS.md', content: 'package rules' })
    const hook = hookWith({ reload: false })
    const input = { path: join(root, 'packages/core/src/foo.ts') }

    await run(hook, { input })
    const other = await run(hook, { input, thread: 'thread-2' })

    expect(other.drafts?.[0]).toMatchObject({ content: 'package rules' })
  })
})
