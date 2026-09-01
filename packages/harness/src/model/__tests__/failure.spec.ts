import { describe, expect, it } from 'bun:test'

import { APICallError } from '@ai-sdk/provider'

import { ModelStreamError } from '../errors'
import { modelFailureOf } from '../failure'

const apiError = (args: {
  statusCode?: number
  responseHeaders?: Record<string, string>
}): APICallError =>
  new APICallError({
    message: 'upstream said no',
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    ...(args.statusCode === undefined ? {} : { statusCode: args.statusCode }),
    ...(args.responseHeaders === undefined ? {} : { responseHeaders: args.responseHeaders }),
  })

describe('reading a model failure off whatever the provider threw', () => {
  it('takes the status straight off an api error', () => {
    expect(modelFailureOf(apiError({ statusCode: 529 }))).toEqual({ status: 529 })
  })

  it('reads seconds out of a retry-after header', () => {
    const failure = modelFailureOf(apiError({ statusCode: 429, responseHeaders: { 'retry-after': '12' } }))

    expect(failure).toEqual({ status: 429, retryAfterMs: 12_000 })
  })

  it('ignores a retry-after that is not a number', () => {
    const failure = modelFailureOf(
      apiError({ statusCode: 429, responseHeaders: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
    )

    expect(failure).toEqual({ status: 429 })
  })

  it('unwraps the stream error the port wrapped the provider error in', () => {
    const wrapped = new ModelStreamError({ message: 'overloaded', cause: apiError({ statusCode: 529 }) })

    expect(modelFailureOf(wrapped)).toEqual({ status: 529 })
  })

  it.each([
    'fetch failed',
    'socket hang up',
    'terminated',
    'read ECONNRESET',
    'connect ETIMEDOUT 1.2.3.4:443',
  ])('reads %p as a dropped connection, which has no status', (message) => {
    expect(modelFailureOf(new Error(message))).toEqual({})
  })

  /**
   * A bug in our own code reaches the same catch as a dropped socket. Retrying one ten times just
   * delays the report, so anything unrecognised is refused rather than assumed transient.
   */
  it('refuses to call a programming error transient', () => {
    expect(modelFailureOf(new TypeError('x.map is not a function'))).toBeNull()
  })

  it('refuses a plain string', () => {
    expect(modelFailureOf('something went wrong')).toBeNull()
  })
})
