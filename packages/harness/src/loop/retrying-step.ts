import {
  DEFAULT_RETRY_POLICY,
  planRetry,
  type Assembled,
  type ChunkFilter,
  type ERetryReason,
  type ModelPort,
  type RetryPolicy,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { modelFailureOf } from '../model/failure'
import { takeModelStep, type SteppedTurn } from './model-step'

export type RetryNotice = {
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: ERetryReason
}

export type Waiting = (notice: RetryNotice) => void

export type RetryDeps = {
  policy?: RetryPolicy | undefined
  onWaiting?: Waiting | undefined
  sleep?: ((args: { ms: number; signal: AbortSignal }) => Promise<void>) | undefined
  jitter?: (() => number) | undefined
}

export function sleepUnlessAborted(args: { ms: number; signal: AbortSignal }): Promise<void> {
  return new Promise<void>((resolve) => {
    if (args.signal.aborted) {
      resolve()
      return
    }

    const settle = () => {
      clearTimeout(timer)
      args.signal.removeEventListener('abort', settle)
      resolve()
    }

    const timer = setTimeout(settle, args.ms)
    args.signal.addEventListener('abort', settle, { once: true })
  })
}

type StepAttempt =
  | { ok: true; stepped: SteppedTurn }
  | { ok: false; message: string; cause: unknown; thrown: boolean }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * `takeModelStep` only converts `ModelStreamError` into a returned failure and rethrows anything
 * else, so a request that fails before the stream opens — a 429 or a refused connection on the
 * initial call — arrives as a throw rather than a result. Both are retried; only a throw is
 * rethrown when the retries run out, so a caller that expected an exception still gets one.
 */
async function attemptModelStep(args: {
  model: ModelPort
  tools: readonly ToolDeclaration[]
  onChunk: ChunkFilter | undefined
  assembled: Assembled
  signal: AbortSignal
}): Promise<StepAttempt> {
  try {
    const stepped = await takeModelStep(args)
    if (stepped.ok) return { ok: true, stepped }
    return { ok: false, message: stepped.message, cause: stepped.cause, thrown: false }
  } catch (error) {
    return { ok: false, message: messageOf(error), cause: error, thrown: true }
  }
}

export async function takeModelStepWithRetry(args: {
  model: ModelPort
  tools: readonly ToolDeclaration[]
  onChunk: ChunkFilter | undefined
  assembled: Assembled
  signal: AbortSignal
  retry?: RetryDeps | undefined
}): Promise<SteppedTurn> {
  const policy = args.retry?.policy ?? DEFAULT_RETRY_POLICY
  const sleep = args.retry?.sleep ?? sleepUnlessAborted
  const jitter = args.retry?.jitter ?? Math.random

  let attempts = 0

  for (;;) {
    const attempt = await attemptModelStep({
      model: args.model,
      tools: args.tools,
      onChunk: args.onChunk,
      assembled: args.assembled,
      signal: args.signal,
    })

    if (attempt.ok) return attempt.stepped

    const settled = (): SteppedTurn => {
      if (attempt.thrown) throw attempt.cause
      return { ok: false, message: attempt.message, cause: attempt.cause }
    }

    if (args.signal.aborted) return settled()

    attempts += 1

    const failure = modelFailureOf(attempt.cause)
    if (failure === null) return settled()

    const decision = planRetry({ failure, attempts, policy, jitter: jitter() })
    if (!decision.retry) return settled()

    args.retry?.onWaiting?.({
      attempt: attempts,
      maxAttempts: policy.maxAttempts,
      delayMs: decision.delayMs,
      reason: decision.reason,
    })

    await sleep({ ms: decision.delayMs, signal: args.signal })
    if (args.signal.aborted) return settled()
  }
}
