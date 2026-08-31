import { describe, expect, it } from 'bun:test'

import { pathsHeld, withPathLock } from '../path-lock'

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('withPathLock', () => {
  it('never lets two holders of one path overlap', async () => {
    const events: string[] = []
    let inside = 0
    let overlapped = false

    const contend = (name: string) =>
      withPathLock({
        path: '/tmp/contended.ts',
        run: async () => {
          inside += 1
          if (inside > 1) overlapped = true
          events.push(`${name}:in`)
          await settle(5)
          events.push(`${name}:out`)
          inside -= 1
        },
      })

    await Promise.all([contend('a'), contend('b'), contend('c')])

    expect(overlapped).toBe(false)
    expect(events).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out'])
  })

  it('lets different paths run at the same time, so one slow file cannot stall another', async () => {
    let bStartedBeforeAFinished = false
    let aDone = false

    const slowA = withPathLock({
      path: '/tmp/slow.ts',
      run: async () => {
        await settle(25)
        aDone = true
      },
    })

    const quickB = withPathLock({
      path: '/tmp/quick.ts',
      run: async () => {
        bStartedBeforeAFinished = !aDone
      },
    })

    await Promise.all([slowA, quickB])

    expect(bStartedBeforeAFinished).toBe(true)
  })

  it('treats two spellings of one path as the same lock', async () => {
    let overlapped = false
    let inside = 0

    const contend = (path: string) =>
      withPathLock({
        path,
        run: async () => {
          inside += 1
          if (inside > 1) overlapped = true
          await settle(5)
          inside -= 1
        },
      })

    await Promise.all([contend('/tmp/x/f.ts'), contend('/tmp/x/../x/f.ts')])

    expect(overlapped).toBe(false)
  })

  it('hands the lock on after a holder throws, rather than wedging the path forever', async () => {
    const failing = withPathLock({
      path: '/tmp/thrower.ts',
      run: async () => {
        throw new Error('the write blew up')
      },
    })

    await expect(failing).rejects.toThrow('the write blew up')

    const after = await withPathLock({ path: '/tmp/thrower.ts', run: async () => 'ran anyway' })

    expect(after).toBe('ran anyway')
  })

  it('returns what the holder returned', async () => {
    expect(await withPathLock({ path: '/tmp/value.ts', run: async () => 42 })).toBe(42)
  })

  it('forgets a path once nobody is waiting on it', async () => {
    const before = pathsHeld()

    await withPathLock({ path: '/tmp/transient.ts', run: async () => undefined })

    expect(pathsHeld()).toBe(before)
  })
})
