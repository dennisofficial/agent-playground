import { describe, expect, it } from 'bun:test'

import type { Event, ThreadId } from '@dltech/atlas-core'

import { createPullRequestLinks, pullRequestLinkKey } from '../links'
import type { PullRequestService } from '../pull-request-service'
import {
  EChecksState,
  EForge,
  EPullRequestLookup,
  EPullRequestState,
  NO_CHECKS,
  type PullRequestReading,
  type RepositoryCheckout,
} from '../pure'

const CHECKOUT: RepositoryCheckout = {
  directory: '/repo',
  branch: 'dennis/first',
  forge: EForge.GitHub,
  remote: { host: 'github.com', owner: 'dltech', repo: 'atlas' },
}

const foundReading = (number: number): PullRequestReading => ({
  lookup: EPullRequestLookup.Found,
  pullRequest: {
    number,
    title: 'a pull request',
    url: `https://github.com/dltech/atlas/pull/${number}`,
    state: EPullRequestState.Open,
    checks: EChecksState.Passing,
    tally: NO_CHECKS,
  },
})

const serviceStandingOn = (
  current: { checkout: RepositoryCheckout; reading: PullRequestReading } | null,
): PullRequestService =>
  ({
    current: () => current,
  }) as unknown as PullRequestService

let nextSeq = 0

const THREAD_A = 'br_1' as ThreadId
const THREAD_B = 'br_2' as ThreadId

const linkEvent = (args: { number: number; branch: string; repo?: string }): Event => {
  nextSeq += 1
  return {
    id: `evt_${nextSeq}`,
    seq: nextSeq,
    threadId: THREAD_A,
    runId: 'run_1',
    depth: 0,
    at: '2026-09-04T12:00:00.000Z',
    type: 'pull-request-linked',
    number: args.number,
    url: `https://github.com/dltech/atlas/pull/${args.number}`,
    repo: args.repo ?? 'github.com/dltech/atlas',
    branch: args.branch,
  } as Event
}

describe('recording a link at turn end', () => {
  it('drafts the pull request the tracked checkout stands on', async () => {
    const links = createPullRequestLinks({
      service: serviceStandingOn({ checkout: CHECKOUT, reading: foundReading(401) }),
    })

    const outcome = await links.recordFound({ threadId: THREAD_A })

    expect(outcome.drafts).toEqual([
      {
        type: 'pull-request-linked',
        number: 401,
        url: 'https://github.com/dltech/atlas/pull/401',
        repo: 'github.com/dltech/atlas',
        branch: 'dennis/first',
      },
    ])
  })

  it('drafts nothing when nothing is tracked or found', async () => {
    const untracked = createPullRequestLinks({ service: serviceStandingOn(null) })
    expect((await untracked.recordFound({ threadId: THREAD_A })).drafts).toBeUndefined()

    const absent = createPullRequestLinks({
      service: serviceStandingOn({
        checkout: CHECKOUT,
        reading: { lookup: EPullRequestLookup.Absent },
      }),
    })
    expect((await absent.recordFound({ threadId: THREAD_A })).drafts).toBeUndefined()
  })

  it('drafts a found pull request only once until the log publishes it', async () => {
    const links = createPullRequestLinks({
      service: serviceStandingOn({ checkout: CHECKOUT, reading: foundReading(401) }),
    })

    await links.recordFound({ threadId: THREAD_A })
    const again = await links.recordFound({ threadId: THREAD_A })
    expect(again.drafts).toBeUndefined()

    links.projection.publish({ events: [linkEvent({ number: 401, branch: 'dennis/first' })] })
    const published = await links.recordFound({ threadId: THREAD_A })
    expect(published.drafts).toBeUndefined()
  })

  it('forgets the session drafts when the thread changes', async () => {
    const links = createPullRequestLinks({
      service: serviceStandingOn({ checkout: CHECKOUT, reading: foundReading(401) }),
    })

    await links.recordFound({ threadId: THREAD_A })
    await links.forgetThread({ threadId: THREAD_B, projectDirectory: '/repo' })

    const outcome = await links.recordFound({ threadId: THREAD_B })
    expect(outcome.drafts).toHaveLength(1)
  })
})

describe('reading links back', () => {
  it('folds the published events oldest first', () => {
    const links = createPullRequestLinks({ service: serviceStandingOn(null) })

    links.projection.publish({
      events: [
        linkEvent({ number: 401, branch: 'dennis/first' }),
        linkEvent({ number: 412, branch: 'dennis/second' }),
      ],
    })

    expect(links.projection.current().map((link) => link.number)).toEqual([401, 412])
  })

  it('keeps the same reference when a republish changes nothing', () => {
    const links = createPullRequestLinks({ service: serviceStandingOn(null) })
    const events = [linkEvent({ number: 401, branch: 'dennis/first' })]

    links.projection.publish({ events })
    const first = links.projection.current()

    let bumped = 0
    links.projection.subscribe(() => {
      bumped += 1
    })
    links.projection.publish({ events: [...events] })

    expect(links.projection.current()).toBe(first)
    expect(bumped).toBe(0)
  })
})

describe('the link key', () => {
  it('is the repository and the number', () => {
    expect(pullRequestLinkKey({ repo: 'github.com/dltech/atlas', number: 401 })).toBe(
      'github.com/dltech/atlas#401',
    )
  })
})
