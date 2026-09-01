import { APICallError } from '@ai-sdk/provider'

import type { ModelFailure } from '@dltech/atlas-core'

import { ModelStreamError } from './errors'

const DROPPED_CONNECTION = [
  'fetch failed',
  'socket hang up',
  'terminated',
  'network request failed',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
]

const SECONDS = 1_000

const DROPPED: ModelFailure = {}

function retryAfterMsOf(headers: Record<string, string> | undefined): number | undefined {
  const header = headers?.['retry-after']
  if (header === undefined) return undefined

  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * SECONDS : undefined
}

const looksLikeDroppedConnection = (message: string): boolean =>
  DROPPED_CONNECTION.some((needle) => message.includes(needle))

export function modelFailureOf(error: unknown): ModelFailure | null {
  if (error instanceof ModelStreamError) return modelFailureOf(error.cause)

  if (APICallError.isInstance(error)) {
    const retryAfterMs = retryAfterMsOf(error.responseHeaders)
    return {
      ...(error.statusCode === undefined ? {} : { status: error.statusCode }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
  }

  if (error instanceof Error && looksLikeDroppedConnection(error.message)) return DROPPED

  return null
}
