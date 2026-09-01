import { describe, expect, it } from 'bun:test'

import { EWorktreeExit } from '../../../events/body'
import { contextFor, log } from '../../__tests__/log-fixture'
import { messagesFromEvents } from '../messages-from-events'
import { worktreeBlock } from '../worktree-block'

const LAUNCH = '/w'
const TREE = '/w/.atlas/worktrees/eng-327'

const entered = { type: 'worktree-entered' as const, path: TREE, branch: 'dennis/eng-327', base: 'origin/main' }

const assembleWith = (events: ReturnType<typeof log>) => {
  const ctx = contextFor({ events })
  const withMessages = messagesFromEvents()({ system: [], messages: [] }, ctx)
  return worktreeBlock({ launchDirectory: LAUNCH })(withMessages, ctx)
}

const textsOf = (assembled: ReturnType<typeof assembleWith>): string[] =>
  assembled.messages.flatMap((entry) =>
    entry.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
  )

describe('telling the model it is in a worktree', () => {
  it('says nothing while no worktree has been entered', () => {
    expect(textsOf(assembleWith(log([{ type: 'user-said', text: 'hello' }])))).toEqual(['hello'])
  })

  it('names the worktree, its branch and what it was branched from', () => {
    const assembled = assembleWith(log([entered, { type: 'user-said', text: 'much later' }]))
    const tail = textsOf(assembled).at(-1) ?? ''

    expect(tail).toContain(TREE)
    expect(tail).toContain('dennis/eng-327')
    expect(tail).toContain('origin/main')
    expect(tail).toContain(LAUNCH)
  })

  it('appends at the tail, not where the entry happened', () => {
    const assembled = assembleWith(
      log([{ type: 'user-said', text: 'hello' }, entered, { type: 'user-said', text: 'much later' }]),
    )

    expect(textsOf(assembled).slice(0, -1)).toEqual(['hello', 'much later'])
  })

  it('tells the model an adopted worktree is tracked, not branched, and will not be removed', () => {
    const assembled = assembleWith(
      log([
        { ...entered, base: 'origin/topic', adopted: true },
        { type: 'user-said', text: 'much later' },
      ]),
    )
    const tail = textsOf(assembled).at(-1) ?? ''

    expect(tail).toContain('which tracks origin/topic')
    expect(tail).not.toContain('branched from')
    expect(tail).toContain('will not remove a worktree Atlas did not create')
  })

  it('says an adopted worktree has no upstream rather than naming a base it does not have', () => {
    const assembled = assembleWith(
      log([
        { type: 'worktree-entered', path: TREE, branch: 'lonely', adopted: true },
        { type: 'user-said', text: 'much later' },
      ]),
    )

    expect(textsOf(assembled).at(-1) ?? '').toContain('which has no upstream')
  })

  it('falls silent once the worktree is exited', () => {
    const assembled = assembleWith(
      log([
        entered,
        { type: 'worktree-exited', path: TREE, action: EWorktreeExit.Keep },
        { type: 'user-said', text: 'back home' },
      ]),
    )

    expect(textsOf(assembled)).toEqual(['back home'])
  })
})
