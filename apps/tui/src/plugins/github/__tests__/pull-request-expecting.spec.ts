import { describe, expect, it } from 'bun:test'

import {
  checkoutKey,
  EChecksState,
  EPullRequestLookup,
  POLL_FLOOR_MS,
  POLL_RUNNING_MS,
  POLL_SETTLED_MS,
} from '../pure'

import { createPullRequestService, EXPECTING_CHECKS_MS } from '../pull-request-service'
import {
  aCheckout,
  pullRequestsAnswering,
  stoppedClock as clock,
  wasFound as found,
} from '../testing'

describe('the window a push opens', () => {
  /** What a push leaves behind: a pull request GitHub has not attached a check to yet. */
  const EMPTY_ROLLUP = found({ checks: EChecksState.None })

  it('chases an empty rollup at the running cadence instead of waiting five minutes', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    expect(port.asked).toHaveLength(1)

    service.expectChecks()
    time.advance(POLL_RUNNING_MS)
    await service.refresh({ checkout })

    expect(port.asked).toHaveLength(2)
    service.dispose()
  })

  it('leaves the settled cadence alone when no push has happened', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(POLL_RUNNING_MS)
    await service.refresh({ checkout })

    expect(port.asked).toHaveLength(1)
    service.dispose()
  })

  it('asks at once rather than waiting out a tick', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })

    service.track({ checkout: aCheckout() })
    await service.refresh({ checkout: aCheckout() })
    expect(port.asked).toHaveLength(1)

    time.advance(POLL_FLOOR_MS)
    service.expectChecks()
    await service.refresh({ checkout: aCheckout() })

    expect(port.asked).toHaveLength(2)
    service.dispose()
  })

  it('still holds inside the floor', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })

    service.track({ checkout: aCheckout() })
    await service.refresh({ checkout: aCheckout() })

    time.advance(POLL_FLOOR_MS - 1)
    service.expectChecks()
    await service.refresh({ checkout: aCheckout() })

    expect(port.asked).toHaveLength(1)
    service.dispose()
  })

  it('goes back to the settled cadence once the window has run out', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    service.expectChecks()

    time.advance(EXPECTING_CHECKS_MS)
    await service.refresh({ checkout })
    const spent = port.asked.length

    time.advance(POLL_RUNNING_MS)
    await service.refresh({ checkout })

    expect(port.asked).toHaveLength(spent)
    service.dispose()
  })

  it('remembers the window even when nothing is being followed yet', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    service.expectChecks()
    await service.refresh({ checkout })
    time.advance(POLL_RUNNING_MS)
    await service.refresh({ checkout })

    expect(port.asked).toHaveLength(2)
    service.dispose()
  })

  it('does nothing once the service is disposed', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const service = createPullRequestService({ pullRequests: port })

    service.track({ checkout: aCheckout() })
    await service.refresh({ checkout: aCheckout() })
    const spent = port.asked.length

    service.dispose()
    service.expectChecks()

    expect(port.asked).toHaveLength(spent)
  })
})

describe('a recheck, which opens no window', () => {
  const EMPTY_ROLLUP = found({ checks: EChecksState.None })

  it('asks once, floor permitting', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })

    service.track({ checkout: aCheckout() })
    await service.refresh({ checkout: aCheckout() })
    expect(port.asked).toHaveLength(1)

    time.advance(POLL_FLOOR_MS)
    service.recheck()
    await service.refresh({ checkout: aCheckout() })

    expect(port.asked).toHaveLength(2)
    service.dispose()
  })

  it('holds inside the floor', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })

    service.track({ checkout: aCheckout() })
    await service.refresh({ checkout: aCheckout() })

    time.advance(POLL_FLOOR_MS - 1)
    service.recheck()
    await service.refresh({ checkout: aCheckout() })

    expect(port.asked).toHaveLength(1)
    service.dispose()
  })

  /** The difference that earns it a separate trigger: a settled pull request goes back to quiet. */
  it('leaves the settled cadence in charge afterwards', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    service.track({ checkout })
    await service.refresh({ checkout })
    time.advance(POLL_FLOOR_MS)
    service.recheck()
    await service.refresh({ checkout })
    const spent = port.asked.length

    time.advance(POLL_RUNNING_MS)
    await service.refresh({ checkout })

    expect(port.asked).toHaveLength(spent)
    service.dispose()
  })

  it('does nothing when nothing is being followed, or once disposed', async () => {
    const port = pullRequestsAnswering(EMPTY_ROLLUP)
    const service = createPullRequestService({ pullRequests: port })

    service.recheck()
    expect(port.asked).toHaveLength(0)

    service.track({ checkout: aCheckout() })
    await service.refresh({ checkout: aCheckout() })
    const spent = port.asked.length

    service.dispose()
    service.recheck()

    expect(port.asked).toHaveLength(spent)
  })
})
