import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EBeforeToolDecision,
  EContentAccess,
  EContextSlot,
  EInstructionFamily,
  EPathForm,
  EPathPresence,
  EToolEffect,
  toCallId,
  type ThreadId,
  type ToolDeclaration,
} from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import { InMemoryFileReadState } from '../../files/read-state'
import { ReadBeforeWriteHook } from '../read-before-write'
import { LoadInstructionsHook, type InstructionSource } from '../load-instructions'

let root: string

const thread = (name: string): ThreadId => name as ThreadId

const rootedAt = (reload: boolean): InstructionSource => {
  return ({ projectDirectory }) => ({
    request: {
      root: projectDirectory,
      cwd: projectDirectory,
      userDirectories: [],
      family: EInstructionFamily.Both,
      includeUser: false,
      includeProject: true,
    },
    reload,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-load-instructions-'))
})

describe('LoadInstructionsHook', () => {
  it('drafts one context-loaded per instruction file it finds', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'be terse')

    const hook = new LoadInstructionsHook({ source: rootedAt(true) })
    const outcome = await hook.run({ threadId: thread('t1'), projectDirectory: root })

    expect(outcome.drafts).toEqual([
      {
        type: 'context-loaded',
        slot: EContextSlot.ProjectInstructions,
        key: join(root, 'AGENTS.md'),
        content: 'be terse',
      },
    ])
  })

  it('drafts nothing when no instruction file exists', async () => {
    const hook = new LoadInstructionsHook({ source: rootedAt(true) })

    expect(await hook.run({ threadId: thread('t1'), projectDirectory: root })).toEqual({})
  })

  it('re-reads every turn while reload is on, so an edit lands mid-conversation', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'first')

    const hook = new LoadInstructionsHook({ source: rootedAt(true) })
    await hook.run({ threadId: thread('t1'), projectDirectory: root })
    writeFileSync(join(root, 'AGENTS.md'), 'second')
    const second = await hook.run({ threadId: thread('t1'), projectDirectory: root })

    expect(second.drafts?.[0]).toMatchObject({ content: 'second' })
  })

  it('reads once per thread while reload is off', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'first')

    const hook = new LoadInstructionsHook({ source: rootedAt(false) })
    const first = await hook.run({ threadId: thread('t1'), projectDirectory: root })
    writeFileSync(join(root, 'AGENTS.md'), 'second')
    const again = await hook.run({ threadId: thread('t1'), projectDirectory: root })

    expect(first.drafts?.[0]).toMatchObject({ content: 'first' })
    expect(again).toEqual({})
  })

  it('freezes per thread, not globally', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'first')

    const hook = new LoadInstructionsHook({ source: rootedAt(false) })
    await hook.run({ threadId: thread('t1'), projectDirectory: root })
    const other = await hook.run({ threadId: thread('t2'), projectDirectory: root })

    expect(other.drafts?.[0]).toMatchObject({ content: 'first' })
  })

  it('reads the new root when the same thread enters a worktree, reload off', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'launch directory rules')
    const worktree = mkdtempSync(join(tmpdir(), 'atlas-load-instructions-worktree-'))
    writeFileSync(join(worktree, 'AGENTS.md'), 'worktree rules')

    const hook = new LoadInstructionsHook({ source: rootedAt(false) })
    await hook.run({ threadId: thread('t1'), projectDirectory: root })
    const entered = await hook.run({ threadId: thread('t1'), projectDirectory: worktree })

    expect(entered.drafts?.[0]).toMatchObject({
      key: join(worktree, 'AGENTS.md'),
      content: 'worktree rules',
    })
  })

  it('still freezes a thread that stays in the worktree it entered', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'atlas-load-instructions-worktree-'))
    writeFileSync(join(worktree, 'AGENTS.md'), 'worktree rules')

    const hook = new LoadInstructionsHook({ source: rootedAt(false) })
    await hook.run({ threadId: thread('t1'), projectDirectory: worktree })
    const again = await hook.run({ threadId: thread('t1'), projectDirectory: worktree })

    expect(again).toEqual({})
  })

  it('records each injected file as a whole-file view for the thread', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'be terse')

    const readState = new InMemoryFileReadState()
    const hook = new LoadInstructionsHook({ source: rootedAt(true), readState })
    await hook.run({ threadId: thread('t1'), projectDirectory: root })

    const view = readState.viewOf({ threadId: thread('t1'), path: join(root, 'AGENTS.md') })
    expect(view?.wholeFile).toBe(true)
  })

  it('records nothing for a thread when no instruction file exists', async () => {
    const readState = new InMemoryFileReadState()
    const hook = new LoadInstructionsHook({ source: rootedAt(true), readState })
    await hook.run({ threadId: thread('t1'), projectDirectory: root })

    expect(readState.viewOf({ threadId: thread('t1'), path: join(root, 'AGENTS.md') })).toBeUndefined()
  })

  it('licenses a write to an injected file, then refuses again once it moves', async () => {
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, 'first')

    const readState = new InMemoryFileReadState()
    const hook = new LoadInstructionsHook({ source: rootedAt(true), readState })
    await hook.run({ threadId: thread('t1'), projectDirectory: root })

    const writeTool: ToolDeclaration = {
      name: 'write',
      description: 'replaces a file',
      effect: EToolEffect.Write,
      inputSchema: z.strictObject({ path: z.string(), content: z.string() }),
      pathFields: [
        {
          field: 'path',
          presence: EPathPresence.Required,
          form: EPathForm.Absolute,
          content: EContentAccess.Overwrites,
        },
      ],
    }
    const guard = new ReadBeforeWriteHook(readState, [writeTool])
    const decide = () =>
      guard.run({
        call: {
          callId: toCallId('call-1'),
          name: 'write',
          input: { path, content: 'replacement' },
          effect: EToolEffect.Write,
          threadId: thread('t1'),
        },
        projectDirectory: root,
        events: [],
        signal: new AbortController().signal,
      })

    expect((await decide()).decision).toBe(EBeforeToolDecision.Allow)

    writeFileSync(path, 'changed on disk since the injection')
    expect((await decide()).decision).toBe(EBeforeToolDecision.Deny)
  })
})
