import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EContextSlot, EInstructionFamily, type ThreadId } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

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
})
