import { APICallError } from '@ai-sdk/provider'

import {
  ModelPort,
  type Assembled,
  type ChunkFilter,
  type ModelStepResult,
  type ProviderIdentity,
  type ToolDeclaration,
} from '@dltech/atlas-core'

export type FaultSpec = {
  status: number
  times: number
  retryAfterSeconds?: number
}

const FAULT_URL = 'https://api.anthropic.com/v1/messages'

const ALWAYS = Number.POSITIVE_INFINITY

function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

export function faultFromEnv(env: Record<string, string | undefined>): FaultSpec | null {
  const status = wholeNumber(env.ATLAS_FAULT_STATUS)
  if (status === undefined) return null

  const times = wholeNumber(env.ATLAS_FAULT_TIMES)
  const retryAfterSeconds = wholeNumber(env.ATLAS_FAULT_RETRY_AFTER)

  return {
    status,
    times: times ?? ALWAYS,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }
}

/**
 * A development-only decorator for exercising the retry path without waiting on a real outage. It
 * throws a genuine `APICallError` rather than a shape of its own, so the failure travels the same
 * route a live 429 or 529 would: unclassified by the port, read by `modelFailureOf`, and retried.
 */
export class FaultingModelPort extends ModelPort {
  readonly identity: ProviderIdentity

  private readonly inner: ModelPort
  private readonly spec: FaultSpec
  private failures = 0

  constructor(args: { inner: ModelPort; spec: FaultSpec }) {
    super()
    this.inner = args.inner
    this.spec = args.spec
    this.identity = args.inner.identity
  }

  async step(args: {
    assembled: Assembled
    tools: readonly ToolDeclaration[]
    signal: AbortSignal
    onChunk?: ChunkFilter
  }): Promise<ModelStepResult> {
    if (this.failures >= this.spec.times) return this.inner.step(args)

    this.failures += 1
    throw this.fault()
  }

  private fault(): APICallError {
    const { retryAfterSeconds, status } = this.spec

    return new APICallError({
      message: `ATLAS_FAULT_STATUS is set, so this request failed with ${status} on purpose`,
      url: FAULT_URL,
      requestBodyValues: {},
      statusCode: status,
      ...(retryAfterSeconds === undefined
        ? {}
        : { responseHeaders: { 'retry-after': String(retryAfterSeconds) } }),
    })
  }
}
