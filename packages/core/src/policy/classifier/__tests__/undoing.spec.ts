import { describe, expect, it } from 'bun:test'

import type { OperatorUtterance } from '../evidence'
import type { WorkspaceFacts } from '../facts'
import { EUndoing, undoingAfter, type ReplayedAct } from '../undoing'
import { REPO, bashEvidence, onMain, writeEvidence } from './fixtures'

const facts: WorkspaceFacts = onMain()

const ran = ({ command, seq }: { command: string; seq: number }): ReplayedAct => {
  const evidence = bashEvidence({ command, facts })
  return { seq, deeds: evidence.deeds, reading: evidence.reading }
}

const wrote = ({ path, seq }: { path: string; seq: number }): ReplayedAct => ({
  seq,
  deeds: writeEvidence({ path, facts }).deeds,
  reading: undefined,
})

const said = (text: string, seq: number): OperatorUtterance => ({ text, seq })

describe('a cleared call the thread went on to undo', () => {
  it('names the path that was written again after the call removed it', () => {
    const undone = undoingAfter({
      candidate: ran({ command: `rm -rf ${REPO}/docs`, seq: 4 }),
      acts: [wrote({ path: `${REPO}/docs/architecture.md`, seq: 9 })],
      said: [],
    })

    expect(undone?.kind).toBe(EUndoing.PathRecreated)
    expect(undone?.seq).toBe(9)
    expect(undone?.detail).toContain('docs/architecture.md')
  })

  it('names the tree that was reset after the call changed it', () => {
    const undone = undoingAfter({
      candidate: wrote({ path: `${REPO}/src/thing.ts`, seq: 3 }),
      acts: [ran({ command: 'git reset --hard HEAD', seq: 7 })],
      said: [],
    })

    expect(undone?.kind).toBe(EUndoing.WorkDiscarded)
    expect(undone?.seq).toBe(7)
  })

  it('counts a later revert commit in the same thread', () => {
    const undone = undoingAfter({
      candidate: ran({ command: 'git commit -m "feat: a thing"', seq: 2 }),
      acts: [ran({ command: 'git revert HEAD', seq: 6 })],
      said: [],
    })

    expect(undone?.kind).toBe(EUndoing.CommitReverted)
  })

  it('counts the developer saying so, and quotes them', () => {
    const undone = undoingAfter({
      candidate: ran({ command: `rm -rf ${REPO}/scratch`, seq: 2 }),
      acts: [],
      said: [said('undo that, it was the wrong directory', 5)],
    })

    expect(undone?.kind).toBe(EUndoing.OperatorRegret)
    expect(undone?.detail).toContain('wrong directory')
  })
})

describe('what is not a miss', () => {
  it('leaves a read-only call alone however the thread ends', () => {
    expect(
      undoingAfter({
        candidate: ran({ command: 'git status', seq: 1 }),
        acts: [ran({ command: 'git reset --hard HEAD', seq: 4 })],
        said: [said('undo that', 5)],
      }),
    ).toBeUndefined()
  })

  it('ignores an undoing that happened before the call', () => {
    expect(
      undoingAfter({
        candidate: wrote({ path: `${REPO}/src/thing.ts`, seq: 8 }),
        acts: [ran({ command: 'git reset --hard HEAD', seq: 4 })],
        said: [said('undo that', 2)],
      }),
    ).toBeUndefined()
  })

  it('ignores a later call that touches somewhere else entirely', () => {
    expect(
      undoingAfter({
        candidate: ran({ command: `rm -rf ${REPO}/docs`, seq: 4 }),
        acts: [wrote({ path: `${REPO}/src/thing.ts`, seq: 9 })],
        said: [],
      }),
    ).toBeUndefined()
  })
})
