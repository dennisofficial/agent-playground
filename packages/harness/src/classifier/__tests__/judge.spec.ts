import { APICallError, type LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'bun:test'

import { EConsultation, EJudgment, type Brief, type Consultation } from '@dltech/atlas-core'

import { HaikuJudge, JUDGE_TIMEOUT_MS } from '../judge'

const USAGE = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
}

const generated = (text: string): LanguageModelV4GenerateResult => ({
  content: text.length === 0 ? [] : [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: USAGE,
  warnings: [],
})

const BRIEF: Brief = {
  system: 'you are a second pair of eyes',
  prompt: 'the call about to run',
  targets: ['worktree:eng-412-sidebar', 'eng-412-sidebar'],
}

const modelSaying = (text: string): MockLanguageModelV4 =>
  new MockLanguageModelV4({ doGenerate: async () => generated(text) })

const retryable = (): APICallError =>
  new APICallError({
    message: 'rate limited',
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  })

const modelRefusing = (error: unknown): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw error
    },
  })

const INTERRUPTED = 'the turn was interrupted'

const modelHanging = (): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) =>
      new Promise<LanguageModelV4GenerateResult>((_, reject) => {
        if (abortSignal === undefined) return
        if (abortSignal.aborted) {
          reject(new Error(INTERRUPTED))
          return
        }
        abortSignal.addEventListener('abort', () => reject(new Error(INTERRUPTED)))
      }),
  })

const consultWith = async (args: {
  model: MockLanguageModelV4
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}): Promise<Consultation> => {
  const judge = new HaikuJudge({
    model: args.model,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  })

  return judge.consult({
    brief: BRIEF,
    signal: args.signal ?? new AbortController().signal,
  })
}

describe('HaikuJudge', () => {
  it('reports the verdict the model gave', async () => {
    const consultation = await consultWith({ model: modelSaying('<verdict>proceed</verdict>') })

    expect(consultation.kind).toBe(EConsultation.Judged)
    expect(
      consultation.kind === EConsultation.Judged ? consultation.verdict.judgment : undefined,
    ).toBe(EJudgment.Proceed)
  })

  it('hands the brief to the model as system and prompt, unchanged', async () => {
    const model = modelSaying('<verdict>proceed</verdict>')
    await consultWith({ model })

    const call = model.doGenerateCalls[0]
    expect(call?.prompt.find((message) => message.role === 'system')?.content).toBe(BRIEF.system)
    expect(call?.maxOutputTokens).toBe(256)
  })

  it('is unreachable, never a throw, when the model rejects', async () => {
    const consultation = await consultWith({ model: modelRefusing(new Error('fetch failed')) })

    expect(consultation.kind).toBe(EConsultation.Unreachable)
    expect(consultation.kind === EConsultation.Unreachable ? consultation.fault : '').toContain(
      'fetch failed',
    )
  })

  it('is unreachable rather than a guess when the answer carries no verdict', async () => {
    const consultation = await consultWith({
      model: modelSaying('I would probably not do that if I were you'),
    })

    expect(consultation.kind).toBe(EConsultation.Unreachable)
  })

  it('is unreachable when the answer checks without naming a target from the brief', async () => {
    const consultation = await consultWith({
      model: modelSaying('<verdict>check</verdict><reason>this feels dangerous</reason>'),
    })

    expect(consultation.kind).toBe(EConsultation.Unreachable)
  })

  it('leaves retries to the policy: one refusal is one attempt', async () => {
    const model = modelRefusing(retryable())
    const consultation = await consultWith({ model })

    expect(model.doGenerateCalls.length).toBe(1)
    expect(consultation.kind).toBe(EConsultation.Unreachable)
  })

  it('lets the turn’s own abort cancel the consultation', async () => {
    const controller = new AbortController()
    const model = modelHanging()
    const pending = consultWith({ model, signal: controller.signal })
    setTimeout(() => controller.abort(), 5)

    const consultation = await pending
    expect(consultation.kind).toBe(EConsultation.Unreachable)
    expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true)
  })

  it('gives up on its own rather than holding a tool call open forever', async () => {
    const consultation = await consultWith({ model: modelHanging(), timeoutMs: 1 })

    expect(consultation.kind).toBe(EConsultation.Unreachable)
  })

  it('waits four seconds by default, so network slowness is not an interruption', () => {
    expect(JUDGE_TIMEOUT_MS).toBe(4000)
  })
})
