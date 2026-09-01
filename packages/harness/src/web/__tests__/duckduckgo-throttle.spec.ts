import { afterEach, describe, expect, it } from 'bun:test'

import { duckDuckGo } from '../backends/duckduckgo'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const page = `
  <div class="result">
    <a class="result__a" href="https://a.test/one">One</a>
    <a class="result__snippet" href="https://a.test/one">the first thing</a>
  </div>`

const serving = (statuses: readonly number[]): (() => number) => {
  let call = 0

  const answer = async (): Promise<Response> => {
    const status = statuses[call] ?? 200
    call += 1
    return status === 200 ? new Response(page, { status: 200 }) : new Response('', { status })
  }

  globalThis.fetch = Object.assign(answer, { preconnect: realFetch.preconnect })
  return () => call
}

describe('the DuckDuckGo backend when it is throttled', () => {
  it('retries a 202 rather than reading it as an empty page', async () => {
    const calls = serving([202, 200])

    const outcome = await duckDuckGo({
      query: 'anything',
      count: 5,
      signal: new AbortController().signal,
      credential: undefined,
    })

    expect(calls()).toBe(2)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0]?.title).toBe('One')
  })

  it('gives up with advice rather than retrying forever', async () => {
    const controller = new AbortController()
    const calls = serving([202, 202, 202, 202])
    controller.abort()

    const outcome = await duckDuckGo({
      query: 'anything',
      count: 5,
      signal: controller.signal,
      credential: undefined,
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('rate-limited')
    expect(outcome.reason).toContain('settings')
    expect(calls()).toBeLessThan(4)
  })

  it('does not retry an ordinary failure', async () => {
    const calls = serving([500])

    const outcome = await duckDuckGo({
      query: 'anything',
      count: 5,
      signal: new AbortController().signal,
      credential: undefined,
    })

    expect(calls()).toBe(1)
    expect(outcome.ok).toBe(false)
  })
})
