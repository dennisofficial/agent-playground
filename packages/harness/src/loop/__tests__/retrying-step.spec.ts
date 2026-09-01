import { describe, expect, it } from 'bun:test'

import { APICallError } from '@ai-sdk/provider'
import {
  ERetryReason,
  ModelPort,
  type Assembled,
  type ModelStepResult,
  type ProviderIdentity,
  type RetryPolicy,
} from '@dltech/atlas-core'

import { ModelStreamError } from '../../model/errors'
import { takeModelStepWithRetry, type RetryNotice } from '../retrying-step'

const POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 10_000 }

const ASSEMBLED = { messages: [], instructions: [], trace: [] } as unknown as Assembled

const REPLIED: ModelStepResult = {
  text: 'done',
  reasoning: [],
  toolCalls: [],
  finishReason: 'stop',
} as unknown as ModelStepResult

const overloaded = (): ModelStreamError =>
  new ModelStreamError({
    message: 'overloaded',
    cause: new APICallError({
      message: 'overloaded',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 529,
    }),
  })

class ScriptedModel extends ModelPort {
  public steps = 0
  readonly identity = { vendor: 'anthropic', modelId: 'claude-test' } as unknown as ProviderIdentity

  constructor(private readonly outcomes: readonly ('fail' | 'ok')[]) {
    super()
  }

  async step(): Promise<ModelStepResult> {
    const outcome = this.outcomes[this.steps] ?? 'ok'
    this.steps += 1
    if (outcome === 'fail') throw overloaded()
    return REPLIED
  }
}

function harness(args: { outcomes: readonly ('fail' | 'ok')[]; policy?: RetryPolicy }) {
  const model = new ScriptedModel(args.outcomes)
  const notices: RetryNotice[] = []
  const slept: number[] = []
  const controller = new AbortController()

  const run = () =>
    takeModelStepWithRetry({
      model,
      tools: [],
      onChunk: undefined,
      assembled: ASSEMBLED,
      signal: controller.signal,
      retry: {
        policy: args.policy ?? POLICY,
        onWaiting: (notice) => notices.push(notice),
        sleep: async ({ ms }) => void slept.push(ms),
        jitter: () => 1,
      },
    })

  return { model, notices, slept, controller, run }
}

describe('retrying a model step that failed for a reason worth retrying', () => {
  it('does not retry a step that worked', async () => {
    const { model, run, notices } = harness({ outcomes: ['ok'] })

    const stepped = await run()

    expect(stepped.ok).toBe(true)
    expect(model.steps).toBe(1)
    expect(notices).toEqual([])
  })

  it('comes back from a 529 and returns the reply', async () => {
    const { model, run } = harness({ outcomes: ['fail', 'ok'] })

    const stepped = await run()

    expect(stepped.ok).toBe(true)
    expect(model.steps).toBe(2)
  })

  it('waits longer each time it fails again', async () => {
    const { slept, run } = harness({ outcomes: ['fail', 'fail', 'ok'] })

    await run()

    expect(slept).toEqual([1_000, 2_000])
  })

  it('gives up once the attempts are spent, and reports the failure', async () => {
    const { model, run } = harness({ outcomes: ['fail', 'fail', 'fail', 'fail', 'fail'] })

    const stepped = await run()

    expect(stepped.ok).toBe(false)
    expect(model.steps).toBe(POLICY.maxAttempts)
  })

  it('tells the operator which attempt is being waited on, and why', async () => {
    const { notices, run } = harness({ outcomes: ['fail', 'ok'] })

    await run()

    expect(notices).toEqual([
      { attempt: 1, maxAttempts: POLICY.maxAttempts, delayMs: 1_000, reason: ERetryReason.Overloaded },
    ])
  })

  it('does not retry a failure the request itself caused', async () => {
    const model = new ScriptedModel([])
    const controller = new AbortController()
    model.step = async () => {
      model.steps += 1
      throw new ModelStreamError({
        message: 'bad request',
        cause: new APICallError({
          message: 'bad request',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          statusCode: 400,
        }),
      })
    }

    const stepped = await takeModelStepWithRetry({
      model,
      tools: [],
      onChunk: undefined,
      assembled: ASSEMBLED,
      signal: controller.signal,
      retry: { policy: POLICY, sleep: async () => {}, jitter: () => 1 },
    })

    expect(stepped.ok).toBe(false)
    expect(model.steps).toBe(1)
  })

  it('stops retrying the moment the operator interrupts', async () => {
    const model = new ScriptedModel(['fail', 'fail', 'fail'])
    const controller = new AbortController()
    const notices: RetryNotice[] = []

    const stepped = await takeModelStepWithRetry({
      model,
      tools: [],
      onChunk: undefined,
      assembled: ASSEMBLED,
      signal: controller.signal,
      retry: {
        policy: POLICY,
        onWaiting: (notice) => notices.push(notice),
        sleep: async () => void controller.abort(),
        jitter: () => 1,
      },
    })

    expect(stepped.ok).toBe(false)
    expect(model.steps).toBe(1)
    expect(notices.length).toBe(1)
  })
})

/**
 * A request that fails before the stream opens throws rather than returning, because
 * `takeModelStep` only converts `ModelStreamError`. That is the shape a 429 or a refused
 * connection on the initial call arrives in, so it has to be retried too.
 */
describe('retrying a failure that was thrown rather than returned', () => {
  const rawApiError = (statusCode: number): APICallError =>
    new APICallError({
      message: `upstream said ${statusCode}`,
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode,
    })

  function throwing(args: { statuses: readonly number[]; policy?: RetryPolicy }) {
    const model = new ScriptedModel([])
    const controller = new AbortController()
    const notices: RetryNotice[] = []
    let calls = 0

    model.step = async () => {
      const status = args.statuses[calls]
      calls += 1
      if (status !== undefined) throw rawApiError(status)
      return REPLIED
    }

    const run = () =>
      takeModelStepWithRetry({
        model,
        tools: [],
        onChunk: undefined,
        assembled: ASSEMBLED,
        signal: controller.signal,
        retry: {
          policy: args.policy ?? POLICY,
          onWaiting: (notice) => notices.push(notice),
          sleep: async () => {},
          jitter: () => 1,
        },
      })

    return { run, notices, calls: () => calls }
  }

  it('retries a rate limit thrown by the initial request, and returns the reply', async () => {
    const { run, calls } = throwing({ statuses: [429] })

    const stepped = await run()

    expect(stepped.ok).toBe(true)
    expect(calls()).toBe(2)
  })

  it('counts the thrown attempt, so the operator sees it being waited on', async () => {
    const { run, notices } = throwing({ statuses: [429] })

    await run()

    expect(notices).toEqual([
      { attempt: 1, maxAttempts: POLICY.maxAttempts, delayMs: 1_000, reason: ERetryReason.RateLimited },
    ])
  })

  it('rethrows a thrown failure that is not worth retrying, rather than swallowing it', async () => {
    const { run, calls } = throwing({ statuses: [401] })

    await expect(run()).rejects.toThrow('upstream said 401')
    expect(calls()).toBe(1)
  })

  it('rethrows the original error once the retries are spent', async () => {
    const spent = Array.from({ length: POLICY.maxAttempts }, () => 529)
    const { run, calls } = throwing({ statuses: spent })

    await expect(run()).rejects.toThrow('upstream said 529')
    expect(calls()).toBe(POLICY.maxAttempts)
  })
})
