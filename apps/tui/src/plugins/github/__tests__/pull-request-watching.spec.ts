import { describe, expect, it } from 'bun:test'

import {
  checkoutKey,
  EPullRequestLookup,
  NO_PULL_REQUEST_READING,
  POLL_SETTLED_MS,
} from '../pure'

import { createPullRequestService } from '../pull-request-service'
import {
  aCheckout,
  aLink,
  pullRequestsAnswering,
  pullRequestsByKey,
  rejectingPort,
  stoppedClock as clock,
  wasFound as found,
  wasUnavailable as unavailable,
} from '../testing'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const LINK_KEY = 'github.com/dennisofficial/atlas#42'

describe('watching linked pull requests', () => {
  it('asks about a new link immediately and publishes it under the link key', async () => {
    const port = pullRequestsByKey({ [LINK_KEY]: found() })
    const service = createPullRequestService({ pullRequests: port })

    service.watch({ links: [aLink()] })
    await sleep(10)

    expect(port.askedLinked).toEqual([LINK_KEY])
    expect(service.snapshot({ key: LINK_KEY })).toEqual(found())
    service.dispose()
  })

  it('keeps polling a watched link on the tick, with no checkout tracked', async () => {
    const port = pullRequestsByKey({ [LINK_KEY]: found() })
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now, tickMs: 1 })

    service.watch({ links: [aLink()] })
    await sleep(10)
    expect(port.askedLinked).toHaveLength(1)

    time.advance(POLL_SETTLED_MS)
    await sleep(20)

    expect(port.askedLinked.length).toBeGreaterThan(1)
    service.dispose()
  })

  it('forgets a link the set no longer holds and never asks about it again', async () => {
    const port = pullRequestsByKey({ [LINK_KEY]: found() })
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now, tickMs: 1 })

    service.watch({ links: [aLink()] })
    await sleep(10)
    expect(service.snapshot({ key: LINK_KEY })).toEqual(found())

    service.watch({ links: [] })
    expect(service.snapshot({ key: LINK_KEY })).toEqual(NO_PULL_REQUEST_READING)

    time.advance(POLL_SETTLED_MS * 2)
    await sleep(20)
    expect(port.askedLinked).toHaveLength(1)
    service.dispose()
  })

  it('keeps watched links polling when tracking stops', async () => {
    const checkout = aCheckout()
    const port = pullRequestsByKey({
      [LINK_KEY]: found(),
      [checkoutKey(checkout)]: found({ number: 7 }),
    })
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now, tickMs: 1 })

    service.track({ checkout })
    service.watch({ links: [aLink()] })
    await sleep(10)
    const askedBefore = port.asked.length

    service.stopTracking()
    time.advance(POLL_SETTLED_MS)
    await sleep(20)

    expect(port.asked).toHaveLength(askedBefore)
    expect(port.askedLinked.length).toBeGreaterThan(1)
    service.dispose()
  })

  it('a hop forgets only the tracked key, never a watched link', async () => {
    const first = aCheckout({ branch: 'main' })
    const second = aCheckout({ branch: 'feature-x' })
    const port = pullRequestsByKey({
      [LINK_KEY]: found(),
      [checkoutKey(first)]: found({ number: 7 }),
      [checkoutKey(second)]: found({ number: 8 }),
    })
    const service = createPullRequestService({ pullRequests: port })

    service.track({ checkout: first })
    service.watch({ links: [aLink()] })
    await sleep(10)

    service.track({ checkout: second })
    await sleep(10)

    expect(service.snapshot({ key: checkoutKey(first) })).toEqual(NO_PULL_REQUEST_READING)
    expect(service.snapshot({ key: LINK_KEY })).toEqual(found())
    expect(service.snapshot({ key: checkoutKey(second) })).toEqual(found({ number: 8 }))
    service.dispose()
  })

  it('backs a retryable linked failure off on the same schedule as a checkout', async () => {
    const port = pullRequestsByKey({ [LINK_KEY]: unavailable(true) })
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now, tickMs: 1 })

    service.watch({ links: [aLink()] })
    await sleep(10)
    expect(port.askedLinked).toHaveLength(1)

    time.advance(30_000)
    await sleep(20)
    expect(port.askedLinked).toHaveLength(1)

    time.advance(30_000)
    await sleep(20)
    expect(port.askedLinked).toHaveLength(2)
    service.dispose()
  })

  it('treats a rejecting readLinked as a retryable failure, as read is', async () => {
    const port = rejectingPort()
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now, tickMs: 1 })

    service.watch({ links: [aLink()] })
    await sleep(10)

    expect(service.snapshot({ key: LINK_KEY })).toEqual({
      lookup: EPullRequestLookup.Unavailable,
      retryable: true,
    })

    time.advance(30_000)
    await sleep(20)
    expect(port.calls).toBe(1)

    time.advance(30_000)
    await sleep(20)
    expect(port.calls).toBe(2)
    service.dispose()
  })
})

describe('current', () => {
  it('is null until a checkout is tracked, and again once tracking stops', async () => {
    const service = createPullRequestService({ pullRequests: pullRequestsAnswering(found()) })
    expect(service.current()).toBeNull()

    const checkout = aCheckout()
    service.track({ checkout })
    await service.refresh({ checkout })

    expect(service.current()).toEqual({ checkout, reading: found() })

    service.stopTracking()
    expect(service.current()).toBeNull()
    service.dispose()
  })

  it('reports the reading the screen shows, not the failure the schedule last heard', async () => {
    const port = pullRequestsAnswering(found(), unavailable(true))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    service.track({ checkout })
    await service.refresh({ checkout })
    time.advance(POLL_SETTLED_MS)
    await service.refresh({ checkout })

    expect(service.current()?.reading).toEqual(found())
    service.dispose()
  })
})
