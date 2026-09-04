import { describe, expect, it } from 'bun:test'

import { toThreadId } from '@dltech/atlas-core'

import { createWarpReporter, WarpThreadOpenHook, type WarpReporter } from '../warp-reporter'

const WARP_ENV = { TERM_PROGRAM: 'WarpTerminal' }

const THREAD = toThreadId('thread-warp')

function capturedReporter(): { reporter: WarpReporter; writes: string[] } {
  const writes: string[] = []
  const reporter = createWarpReporter({
    env: WARP_ENV,
    write: (sequence) => writes.push(sequence),
    host: 'mac.local',
  })
  if (reporter === null) throw new Error('expected a reporter inside Warp')
  return { reporter, writes }
}

describe('createWarpReporter', () => {
  it('is null outside Warp', () => {
    expect(
      createWarpReporter({ env: {}, write: () => undefined, host: 'mac.local' }),
    ).toBeNull()
    expect(
      createWarpReporter({
        env: { TERM_PROGRAM: 'iTerm.app' },
        write: () => undefined,
        host: 'mac.local',
      }),
    ).toBeNull()
  })

  it('creates a reporter inside Warp', () => {
    expect(
      createWarpReporter({ env: WARP_ENV, write: () => undefined, host: 'mac.local' }),
    ).not.toBeNull()
  })
})

describe('OscWarpReporter', () => {
  it('points the tab at the opened directory via OSC 7', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/Users/dennis/atlas' })

    expect(writes).toEqual(['\x1b]7;file://mac.local/Users/dennis/atlas\x1b\\'])
  })

  it('follows the directory on every thread open, including worktrees', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/Users/dennis/atlas' })
    reporter.handleThreadOpened({
      projectDirectory: '/Users/dennis/atlas/.atlas/worktrees/warp integration',
    })

    expect(writes.at(-1)).toBe(
      '\x1b]7;file://mac.local/Users/dennis/atlas/.atlas/worktrees/warp%20integration\x1b\\',
    )
  })

  it('survives a write that throws', () => {
    const reporter = createWarpReporter({
      env: WARP_ENV,
      write: () => {
        throw new Error('EPIPE')
      },
      host: 'mac.local',
    })
    reporter?.handleThreadOpened({ projectDirectory: '/x' })
  })
})

describe('WarpThreadOpenHook', () => {
  it('forwards the opened directory', async () => {
    const { reporter, writes } = capturedReporter()
    const hook = new WarpThreadOpenHook(reporter)
    const outcome = await hook.run({
      threadId: THREAD,
      projectDirectory: '/Users/dennis/atlas',
    })

    expect(outcome).toEqual({})
    expect(writes).toEqual(['\x1b]7;file://mac.local/Users/dennis/atlas\x1b\\'])
  })
})

