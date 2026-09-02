import { describe, expect, it } from 'bun:test'

import { ECompactionAnchor, EWorktreeExit } from '../../../events/body'
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
    const assembled = assembleWith(log([{ type: 'user-said', text: 'hello' }]))

    expect(assembled.system).toEqual([])
    expect(textsOf(assembled)).toEqual(['hello'])
  })

  it('names the worktree, its branch and what it was branched from', () => {
    const note = assembleWith(log([entered])).system.at(-1)?.text ?? ''

    expect(note).toContain(TREE)
    expect(note).toContain('dennis/eng-327')
    expect(note).toContain('origin/main')
    expect(note).toContain(LAUNCH)
  })

  it('rides the system prompt rather than the message tail, so it never reads as a new instruction', () => {
    const assembled = assembleWith(
      log([{ type: 'user-said', text: 'hello' }, entered, { type: 'user-said', text: 'much later' }]),
    )

    expect(textsOf(assembled)).toEqual(['hello', 'much later'])
    expect(assembled.system.at(-1)?.text).toContain(TREE)
  })

  it('tells the model an adopted worktree is tracked, not branched, and will not be removed', () => {
    const note =
      assembleWith(log([{ ...entered, base: 'origin/topic', adopted: true }])).system.at(-1)?.text ?? ''

    expect(note).toContain('which tracks origin/topic')
    expect(note).not.toContain('branched from')
    expect(note).toContain('will not remove a worktree Atlas did not create')
  })

  it('says an adopted worktree has no upstream rather than naming a base it does not have', () => {
    const note =
      assembleWith(log([{ type: 'worktree-entered', path: TREE, branch: 'lonely', adopted: true }]))
        .system.at(-1)?.text ?? ''

    expect(note).toContain('which has no upstream')
  })

  it('falls silent once the worktree is exited', () => {
    const assembled = assembleWith(
      log([entered, { type: 'worktree-exited', path: TREE, action: EWorktreeExit.Keep }]),
    )

    expect(assembled.system).toEqual([])
  })

  it('still folds the entry after the history covering it is compacted', () => {
    const assembled = assembleWith(
      log([
        entered,
        { type: 'user-said', text: 'hello' },
        {
          type: 'history-compacted',
          anchor: ECompactionAnchor.Prefix,
          fromSeq: 1,
          throughSeq: 2,
          summary: 'The session entered a worktree.',
          replaced: 2,
        },
      ]),
    )

    expect(assembled.system.at(-1)?.text).toContain(TREE)
  })
})
