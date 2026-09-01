import { describe, expect, it } from 'bun:test'

import {
  checkoutKey,
  EChecksState,
  EPullRequestLookup,
  POLL_SETTLED_MS,
  type ChecksTally,
  type PullRequestReading,
} from '../pure'

import { createPullRequestService } from '../pull-request-service'
import {
  aCheckout,
  countingPort,
  pullRequestsAnswering,
  rejectingPort,
  suspendedPort,
  stoppedClock as clock,
  WAS_ABSENT as ABSENT,
  wasFound as found,
  wasUnavailable as unavailable,
} from '../testing'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('createPullRequestService', () => {
  it('publishes the first reading under the checkout key', async () => {
    const service = createPullRequestService({ pullRequests: pullRequestsAnswering(found()) })
    const checkout = aCheckout()

    await service.refresh({ checkout })

    expect(service.snapshot({ key: checkoutKey(checkout) })).toEqual(found())
    expect(service.version()).toBe(1)
    service.dispose()
  })

  it('holds a second ask inside the floor, forced or not', async () => {
    const port = pullRequestsAnswering(found(), found({ number: 43 }))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(9_000)
    await service.refresh({ checkout, force: true })

    expect(port.asked).toHaveLength(1)
    service.dispose()
  })

  it('asks again once the settled interval has passed', async () => {
    const port = pullRequestsAnswering(found(), found({ number: 43 }))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(POLL_SETTLED_MS)
    await service.refresh({ checkout })

    expect(port.asked).toHaveLength(2)
    service.dispose()
  })

  it('backs off after a retryable failure and doubles the wait', async () => {
    const port = pullRequestsAnswering(unavailable(true))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(30_000)
    await service.refresh({ checkout })
    expect(port.asked).toHaveLength(1)

    time.advance(30_000)
    await service.refresh({ checkout })
    expect(port.asked).toHaveLength(2)

    time.advance(60_000)
    await service.refresh({ checkout })
    expect(port.asked).toHaveLength(2)

    time.advance(60_000)
    await service.refresh({ checkout })
    expect(port.asked).toHaveLength(3)
    service.dispose()
  })

  it('never retries a failure that will not become true on a timer', async () => {
    const port = pullRequestsAnswering(unavailable(false))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(60 * 60_000)
    await service.refresh({ checkout })

    expect(port.asked).toHaveLength(1)
    service.dispose()
  })

  it('lets a trigger force past a failure that would never retry on its own', async () => {
    const port = pullRequestsAnswering(unavailable(false))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(60_000)
    await service.refresh({ checkout, force: true })

    expect(port.asked).toHaveLength(2)
    service.dispose()
  })

  it('keeps the last pull request on screen when the next reading is unavailable', async () => {
    const port = pullRequestsAnswering(found(), unavailable(true))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(POLL_SETTLED_MS)
    await service.refresh({ checkout })

    expect(service.snapshot({ key: checkoutKey(checkout) })).toEqual(found())
    service.dispose()
  })

  it('clears the pill when the pull request is definitively gone', async () => {
    const port = pullRequestsAnswering(found(), ABSENT)
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    time.advance(POLL_SETTLED_MS)
    await service.refresh({ checkout })

    expect(service.snapshot({ key: checkoutKey(checkout) })).toEqual(ABSENT)
    service.dispose()
  })

  it('does not bump the version when a poll finds the same pull request', async () => {
    const port = pullRequestsAnswering(found(), found())
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    const published = service.version()
    time.advance(POLL_SETTLED_MS)
    await service.refresh({ checkout })

    expect(service.version()).toBe(published)
    service.dispose()
  })

  it('publishes a check that finished even though the roll-up state has not moved', async () => {
    const running = (tally: ChecksTally): PullRequestReading =>
      found({ checks: EChecksState.Running, tally })
    const port = pullRequestsAnswering(
      running({ running: 2, passed: 1, failed: 0 }),
      running({ running: 1, passed: 2, failed: 0 }),
    )
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })
    const published = service.version()
    time.advance(POLL_SETTLED_MS)
    await service.refresh({ checkout })

    const reading = service.snapshot({ key: checkoutKey(checkout) })
    expect(service.version()).toBeGreaterThan(published)
    expect(reading.lookup).toBe(EPullRequestLookup.Found)
    if (reading.lookup !== EPullRequestLookup.Found) return
    expect(reading.pullRequest.tally).toEqual({ running: 1, passed: 2, failed: 0 })
    service.dispose()
  })

  it('treats a port that rejects as a retryable failure and backs off', async () => {
    const port = rejectingPort()
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const checkout = aCheckout()

    await service.refresh({ checkout })

    expect(service.snapshot({ key: checkoutKey(checkout) })).toEqual({
      lookup: EPullRequestLookup.Unavailable,
      retryable: true,
    })

    time.advance(30_000)
    await service.refresh({ checkout })
    expect(port.calls).toBe(1)

    time.advance(30_000)
    await service.refresh({ checkout })
    expect(port.calls).toBe(2)
    service.dispose()
  })

  it('forgets the previous key the moment a new one is tracked', async () => {
    const port = pullRequestsAnswering(found(), found({ number: 43 }))
    const time = clock(1_000_000)
    const service = createPullRequestService({ pullRequests: port, now: time.now })
    const first = aCheckout({ branch: 'main' })
    const second = aCheckout({ branch: 'feature-x' })

    service.track({ checkout: first })
    await service.refresh({ checkout: first })
    expect(service.snapshot({ key: checkoutKey(first) })).toEqual(found())

    service.track({ checkout: second })
    expect(service.snapshot({ key: checkoutKey(first) }).lookup).toBe(
      EPullRequestLookup.Unavailable,
    )

    await service.refresh({ checkout: second })
    expect(service.snapshot({ key: checkoutKey(second) })).toEqual(found({ number: 43 }))
    service.dispose()
  })

  it('shares one in-flight promise between concurrent callers', async () => {
    const { port, gate } = suspendedPort()
    const service = createPullRequestService({ pullRequests: port })
    const checkout = aCheckout()

    const both = Promise.all([service.refresh({ checkout }), service.refresh({ checkout })])
    gate.settle?.(found())
    await both

    expect(port.calls).toBe(1)
    service.dispose()
  })

  it('publishes nothing from a response that lands after disposal', async () => {
    const { port, gate } = suspendedPort()
    const service = createPullRequestService({ pullRequests: port })
    let notified = 0
    service.subscribe(() => {
      notified += 1
    })

    const asked = service.refresh({ checkout: aCheckout() })
    service.dispose()
    gate.settle?.(found())
    await asked

    expect(notified).toBe(0)
    expect(service.version()).toBe(0)
  })

  it('arms no timer for a port that pushes, and one for a port that does not', async () => {
    const pushing = countingPort({ pushes: true, reading: ABSENT })
    const polling = countingPort({ pushes: false, reading: ABSENT })
    const time = clock(1_000_000)
    const pushed = createPullRequestService({ pullRequests: pushing, now: time.now, tickMs: 1 })
    const polled = createPullRequestService({ pullRequests: polling, now: time.now, tickMs: 1 })

    pushed.track({ checkout: aCheckout() })
    polled.track({ checkout: aCheckout() })
    time.advance(POLL_SETTLED_MS)
    await sleep(20)

    expect(pushing.calls).toBe(1)
    expect(polling.calls).toBeGreaterThan(1)
    pushed.dispose()
    polled.dispose()
  })
})
