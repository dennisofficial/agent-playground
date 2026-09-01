import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act, useState } from 'react'

import { settle, teardown } from '../../../ui/markdown/__tests__/harness'
import { createPullRequestService, type PullRequestService } from '../pull-request-service'
import {
  EForge,
  EPullRequestLookup,
  PullRequestPort,
  type PullRequestReading,
  type RepositoryCheckout,
} from '../pure'
import { usePullRequest, type CheckoutProbe, type PullRequestControl } from '../use-pull-request'

import { spansOf } from '../../../ui/sidebar-section'

const WIDE = 200

const RENDER_MS = 40

const checkoutIn = (directory: string, branch = 'feature-x'): RepositoryCheckout => ({
  directory,
  branch,
  forge: EForge.GitHub,
  remote: { host: 'github.com', owner: 'dennisofficial', repo: 'atlas' },
})

const absentPort = (): PullRequestPort =>
  new (class extends PullRequestPort {
    readonly pushes = true
    async read(): Promise<PullRequestReading> {
      return { lookup: EPullRequestLookup.Absent }
    }
  })()

type Tracked = { directories: string[]; stops: number }

/**
 * The service is real; only what it was asked to follow is recorded, because the defect this pins
 * is which directory `track` was last handed rather than what the port answered.
 */
const watchingService = (): {
  service: PullRequestService
  real: PullRequestService
  tracked: Tracked
} => {
  const real = createPullRequestService({ pullRequests: absentPort() })
  const tracked: Tracked = { directories: [], stops: 0 }

  const service: PullRequestService = {
    ...real,
    track: (request) => {
      tracked.directories.push(request.checkout.directory)
      real.track(request)
    },
    stopTracking: () => {
      tracked.stops += 1
      real.stopTracking()
    },
  }

  return { service, real, tracked }
}

type Probe = {
  control: PullRequestControl | null
  setDirectory: ((directory: string) => void) | null
  setWorking: ((working: boolean) => void) | null
}

const NEVER = (): void => undefined

function Watcher(props: {
  probe: Probe
  service: PullRequestService
  askGit: CheckoutProbe
  directory: string
}): React.ReactNode {
  const [directory, setDirectory] = useState(props.directory)
  const [working, setWorking] = useState(false)

  props.probe.setDirectory = setDirectory
  props.probe.setWorking = setWorking
  props.probe.control = usePullRequest({
    service: props.service,
    projectDirectory: directory,
    working,
    onOpen: NEVER,
    probe: props.askGit,
  })

  return <text>{props.probe.control.badge?.label ?? 'no pull request'}</text>
}

async function mounted(args: { askGit: CheckoutProbe; directory?: string }): Promise<{
  probe: Probe
  tracked: Tracked
  flush: () => Promise<void>
  done: () => Promise<void>
}> {
  const { service, real, tracked } = watchingService()
  const probe: Probe = { control: null, setDirectory: null, setWorking: null }

  const setup = await testRender(
    <Watcher
      probe={probe}
      service={service}
      askGit={args.askGit}
      directory={args.directory ?? '/work/atlas'}
    />,
    { width: 60, height: 4 },
  )
  const flush = async (): Promise<void> => {
    await act(async () => {
      await settle(RENDER_MS)
    })
    await setup.flush()
  }
  await flush()

  return {
    probe,
    tracked,
    flush,
    done: async () => {
      await teardown(setup)
      real.dispose()
    },
  }
}

const branchOf = (probe: Probe): string | null => {
  const row = probe.control?.section?.rows.find((entry) => entry.id === 'branch')
  return row === undefined ? null : spansOf({ row: row, cells: WIDE }).map((span) => span.text).join('')
}

const countingProbe = (): CheckoutProbe & { calls: string[] } => {
  const calls: string[] = []
  return Object.assign(
    async ({ directory }: { directory: string }) => {
      calls.push(directory)
      return checkoutIn(directory)
    },
    { calls },
  )
}

describe('what makes usePullRequest ask git again', () => {
  it('probes once on mount, not once per effect', async () => {
    const askGit = countingProbe()
    const { tracked, done } = await mounted({ askGit })

    try {
      expect(askGit.calls).toEqual(['/work/atlas'])
      expect(tracked.directories).toEqual(['/work/atlas'])
    } finally {
      await done()
    }
  })

  /**
   * The turn is the only thing that plausibly pushed a commit or switched branch, and a branch can
   * change without the directory changing, so the end of a turn re-probes rather than merely
   * re-asking.
   */
  it('re-probes when the turn ends, and not when it starts', async () => {
    const askGit = countingProbe()
    const { probe, flush, done } = await mounted({ askGit })

    try {
      act(() => probe.setWorking?.(true))
      await flush()
      expect(askGit.calls).toHaveLength(1)

      act(() => probe.setWorking?.(false))
      await flush()
      expect(askGit.calls).toEqual(['/work/atlas', '/work/atlas'])
    } finally {
      await done()
    }
  })

  it('re-probes on a directory change even while the turn is still running', async () => {
    const askGit = countingProbe()
    const { probe, flush, done } = await mounted({ askGit })

    try {
      act(() => probe.setWorking?.(true))
      await flush()
      act(() => probe.setDirectory?.('/work/atlas/.claude/worktrees/thing'))
      await flush()

      expect(askGit.calls).toEqual(['/work/atlas', '/work/atlas/.claude/worktrees/thing'])
    } finally {
      await done()
    }
  })

  it('stops tracking when the directory is not a repository', async () => {
    const askGit: CheckoutProbe = async () => null
    const { probe, tracked, done } = await mounted({ askGit })

    try {
      expect(tracked.directories).toEqual([])
      expect(tracked.stops).toBeGreaterThan(0)
      expect(probe.control?.badge).toBeNull()
    } finally {
      await done()
    }
  })
})

describe('a probe that lands out of order', () => {
  /**
   * Two `git` calls started against different directories can settle in either order. The slow one
   * belongs to a directory the session has already left, so it must not re-track it — doing so
   * re-arms polling on the previous branch and puts its pull request back on the footer.
   */
  it('never re-tracks the directory the session has left', async () => {
    const held: { release: (() => void) | null } = { release: null }
    const askGit: CheckoutProbe = async ({ directory }) => {
      if (directory === '/work/old') {
        await new Promise<void>((resolve) => {
          held.release = resolve
        })
      }
      return checkoutIn(directory)
    }

    const { probe, tracked, flush, done } = await mounted({
      askGit,
      directory: '/work/old',
    })

    try {
      expect(tracked.directories).toEqual([])

      act(() => probe.setDirectory?.('/work/new'))
      await flush()
      expect(tracked.directories).toEqual(['/work/new'])

      act(() => held.release?.())
      await flush()

      expect(tracked.directories).toEqual(['/work/new'])
      expect(branchOf(probe)).toBe('feature-x')
    } finally {
      held.release?.()
      await done()
    }
  })
})

describe('the contributed section', () => {
  it('names the branch it probed, and holds the same object until something changes', async () => {
    const askGit = countingProbe()
    const { probe, flush, done } = await mounted({ askGit })

    try {
      const first = probe.control?.section
      expect(branchOf(probe)).toBe('feature-x')

      await flush()
      expect(probe.control?.section).toBe(first)
    } finally {
      await done()
    }
  })

  it('says nothing at all while the directory is not a repository', async () => {
    const askGit: CheckoutProbe = async () => null
    const { probe, done } = await mounted({ askGit })

    try {
      expect(probe.control?.section).toBeNull()
    } finally {
      await done()
    }
  })
})
