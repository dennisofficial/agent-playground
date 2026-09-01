import { describe, expect, it } from 'bun:test'

import { createLineMatcher } from '../shell-watch'

const matcher = ({ source, cap = 200 }: { source: string; cap?: number }) =>
  createLineMatcher({ pattern: new RegExp(source), cap })

describe('testing a pattern against each line a shell prints', () => {
  it('keeps the lines that match and drops the ones that do not', () => {
    const watch = matcher({ source: 'ERROR' })

    watch.append('starting\nERROR: boom\nstill going\n')

    expect(watch.take()).toMatchObject({ lines: ['ERROR: boom'], matchCount: 1 })
  })

  it('waits for the newline rather than matching half a line twice', () => {
    const watch = matcher({ source: 'ERROR' })

    watch.append('ERR')
    expect(watch.pending()).toBe(false)

    watch.append('OR: split across chunks\n')

    expect(watch.take().lines).toEqual(['ERROR: split across chunks'])
  })

  it('takes what has accumulated once and leaves nothing behind', () => {
    const watch = matcher({ source: 'hit' })
    watch.append('hit one\nhit two\n')

    expect(watch.take().matchCount).toBe(2)
    expect(watch.take()).toMatchObject({ lines: [], matchCount: 0 })
  })

  it('matches an alternation, so a failure wakes the reader as fast as a pass', () => {
    const watch = matcher({ source: 'completed|FAILED|Traceback' })

    watch.append('queued\nFAILED: the review errored\n')

    expect(watch.take().lines).toEqual(['FAILED: the review errored'])
  })
})

describe('disarming a watch that has said enough', () => {
  it('stops matching at the cap and says so on the batch that reached it', () => {
    const watch = matcher({ source: 'hit', cap: 3 })

    watch.append('hit 1\nhit 2\nhit 3\nhit 4\nhit 5\n')

    const taken = watch.take()
    expect(taken.lines).toEqual(['hit 1', 'hit 2', 'hit 3'])
    expect(taken.disarmed).toBe(true)
  })

  it('counts the lines already handed over towards the cap', () => {
    const watch = matcher({ source: 'hit', cap: 3 })

    watch.append('hit 1\nhit 2\n')
    expect(watch.take().disarmed).toBe(false)

    watch.append('hit 3\nhit 4\n')

    expect(watch.take()).toMatchObject({ lines: ['hit 3'], disarmed: true })
  })

  it('stays quiet once disarmed, however much more matches', () => {
    const watch = matcher({ source: 'hit', cap: 1 })
    watch.append('hit 1\n')
    watch.take()

    watch.append('hit 2\nhit 3\n')

    expect(watch.pending()).toBe(false)
  })
})
