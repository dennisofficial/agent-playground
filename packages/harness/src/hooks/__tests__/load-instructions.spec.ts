import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EContextSlot, EInstructionFamily, type ThreadId } from '@dltech/atlas-core'
import { beforeEach, describe, expect, it } from 'bun:test'

import { LoadInstructionsHook, type InstructionPlan } from '../load-instructions'

let root: string

const thread = (name: string): ThreadId => name as ThreadId

const planFor = (reload: boolean): InstructionPlan => ({
  request: {
    root,
    cwd: root,
    userDirectories: [],
    family: EInstructionFamily.Both,
    includeUser: false,
    includeProject: true,
  },
  reload,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-load-instructions-'))
})

describe('LoadInstructionsHook', () => {
  it('drafts one context-loaded per instruction file it finds', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'be terse')

    const hook = new LoadInstructionsHook({ source: () => planFor(true) })
    const outcome = await hook.run({ threadId: thread('t1') })

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
    const hook = new LoadInstructionsHook({ source: () => planFor(true) })

    expect(await hook.run({ threadId: thread('t1') })).toEqual({})
  })

  it('re-reads every turn while reload is on, so an edit lands mid-conversation', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'first')

    const hook = new LoadInstructionsHook({ source: () => planFor(true) })
    await hook.run({ threadId: thread('t1') })
    writeFileSync(join(root, 'AGENTS.md'), 'second')
    const second = await hook.run({ threadId: thread('t1') })

    expect(second.drafts?.[0]).toMatchObject({ content: 'second' })
  })

  it('reads once per thread while reload is off', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'first')

    const hook = new LoadInstructionsHook({ source: () => planFor(false) })
    const first = await hook.run({ threadId: thread('t1') })
    writeFileSync(join(root, 'AGENTS.md'), 'second')
    const again = await hook.run({ threadId: thread('t1') })

    expect(first.drafts?.[0]).toMatchObject({ content: 'first' })
    expect(again).toEqual({})
  })

  it('freezes per thread, not globally', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'first')

    const hook = new LoadInstructionsHook({ source: () => planFor(false) })
    await hook.run({ threadId: thread('t1') })
    const other = await hook.run({ threadId: thread('t2') })

    expect(other.drafts?.[0]).toMatchObject({ content: 'first' })
  })
})
