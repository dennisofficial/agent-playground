import { describe, expect, it } from 'bun:test'

import { APICallError } from '@ai-sdk/provider'
import {
  ModelPort,
  type Assembled,
  type ModelStepResult,
  type ProviderIdentity,
} from '@dltech/atlas-core'

import { FaultingModelPort, faultFromEnv } from '../faulting-model'
import { modelFailureOf } from '../failure'

const ASSEMBLED = { messages: [], instructions: [], trace: [] } as unknown as Assembled

const IDENTITY = { vendor: 'anthropic', modelId: 'claude-test' } as unknown as ProviderIdentity

const REPLIED: ModelStepResult = {
  parts: [],
  toolCalls: [],
  finishReason: 'stop',
} as unknown as ModelStepResult

class CountingModel extends ModelPort {
  public steps = 0
  readonly identity = IDENTITY

  async step(): Promise<ModelStepResult> {
    this.steps += 1
    return REPLIED
  }
}

const stepping = (model: ModelPort) =>
  model.step({ assembled: ASSEMBLED, tools: [], signal: new AbortController().signal })

describe('reading a fault out of the environment', () => {
  it('is off unless a status is named', () => {
    expect(faultFromEnv({})).toBeNull()
  })

  it('refuses a status that is not a number, rather than failing every call', () => {
    expect(faultFromEnv({ ATLAS_FAULT_STATUS: 'overloaded' })).toBeNull()
  })

  it('fails forever when no count is given, so the giving-up path is reachable', () => {
    expect(faultFromEnv({ ATLAS_FAULT_STATUS: '529' })).toEqual({
      status: 529,
      times: Number.POSITIVE_INFINITY,
    })
  })

  it('fails a named number of times, so the recovery path is reachable', () => {
    expect(faultFromEnv({ ATLAS_FAULT_STATUS: '429', ATLAS_FAULT_TIMES: '2' })).toEqual({
      status: 429,
      times: 2,
    })
  })

  it('carries a retry-after, so the header branch is reachable', () => {
    expect(
      faultFromEnv({ ATLAS_FAULT_STATUS: '429', ATLAS_FAULT_RETRY_AFTER: '5' }),
    ).toEqual({ status: 429, times: Number.POSITIVE_INFINITY, retryAfterSeconds: 5 })
  })
})

describe('a model port that fails on purpose', () => {
  it('passes the identity of the model it wraps through', () => {
    const faulting = new FaultingModelPort({
      inner: new CountingModel(),
      spec: { status: 529, times: 1 },
    })

    expect(faulting.identity).toBe(IDENTITY)
  })

  it('throws the named status instead of calling the model it wraps', async () => {
    const inner = new CountingModel()
    const faulting = new FaultingModelPort({ inner, spec: { status: 529, times: 1 } })

    await expect(stepping(faulting)).rejects.toThrow()
    expect(inner.steps).toBe(0)
  })

  /**
   * Thrown as a real provider error so it travels the path a live 529 would, rather than a shape
   * only the fault injector produces.
   */
  it('throws something the retry loop can classify', async () => {
    const faulting = new FaultingModelPort({
      inner: new CountingModel(),
      spec: { status: 529, times: 1 },
    })

    const thrown = await stepping(faulting).catch((error: unknown) => error)

    expect(APICallError.isInstance(thrown)).toBe(true)
    expect(modelFailureOf(thrown)).toEqual({ status: 529 })
  })

  it('carries a retry-after the retry loop will obey', async () => {
    const faulting = new FaultingModelPort({
      inner: new CountingModel(),
      spec: { status: 429, times: 1, retryAfterSeconds: 5 },
    })

    const thrown = await stepping(faulting).catch((error: unknown) => error)

    expect(modelFailureOf(thrown)).toEqual({ status: 429, retryAfterMs: 5_000 })
  })

  it('steps through to the real model once it has failed its count', async () => {
    const inner = new CountingModel()
    const faulting = new FaultingModelPort({ inner, spec: { status: 529, times: 2 } })

    await expect(stepping(faulting)).rejects.toThrow()
    await expect(stepping(faulting)).rejects.toThrow()
    const third = await stepping(faulting)

    expect(third).toBe(REPLIED)
    expect(inner.steps).toBe(1)
  })

  it('never steps through when it was told to fail forever', async () => {
    const inner = new CountingModel()
    const faulting = new FaultingModelPort({
      inner,
      spec: { status: 529, times: Number.POSITIVE_INFINITY },
    })

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(stepping(faulting)).rejects.toThrow()
    }

    expect(inner.steps).toBe(0)
  })
})
