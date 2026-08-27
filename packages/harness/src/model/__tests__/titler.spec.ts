import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'bun:test'

import { sanitizedTitle, titleFor } from '../titler'

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
}

const generated = (text: string): LanguageModelV4GenerateResult => ({
  content: text.length === 0 ? [] : [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: USAGE,
  warnings: [],
})

const modelSaying = (text: string): MockLanguageModelV4 =>
  new MockLanguageModelV4({ doGenerate: async () => generated(text) })

const modelRaising = (error: unknown): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw error
    },
  })

const promptTextOf = (model: MockLanguageModelV4): string => {
  const user = model.doGenerateCalls[0]?.prompt.find((message) => message.role === 'user')
  const part = user?.content.find((content) => content.type === 'text')
  return part?.type === 'text' ? part.text : ''
}

describe('sanitizedTitle', () => {
  it('keeps a name the model already gave in the shape asked for', () => {
    expect(sanitizedTitle('Refresh token rotation')).toBe('Refresh token rotation')
  })

  it('strips the quotes a model wraps its answer in', () => {
    expect(sanitizedTitle('"Refresh token rotation"')).toBe('Refresh token rotation')
    expect(sanitizedTitle('“Refresh token rotation”')).toBe('Refresh token rotation')
  })

  it('strips punctuation the name does not need', () => {
    expect(sanitizedTitle('Refresh token rotation.')).toBe('Refresh token rotation')
    expect(sanitizedTitle('Refresh token rotation?!')).toBe('Refresh token rotation')
  })

  it('puts a name that arrived over several lines onto one', () => {
    expect(sanitizedTitle('Refresh\n  token\trotation')).toBe('Refresh token rotation')
  })

  it('keeps at most six words', () => {
    expect(sanitizedTitle('one two three four five six seven eight')).toBe(
      'one two three four five six',
    )
  })

  it('cuts an overlong name at a word boundary rather than mid-word', () => {
    const title = sanitizedTitle('supercalifragilistic expialidocious antidisestablishmentarian')

    expect(title).toBe('supercalifragilistic expialidocious')
    expect(title?.endsWith(' ')).toBe(false)
  })

  it('reports nothing when the model said nothing worth keeping', () => {
    expect(sanitizedTitle('')).toBeNull()
    expect(sanitizedTitle('   \n  ')).toBeNull()
    expect(sanitizedTitle('"..."')).toBeNull()
  })
})

describe('titleFor', () => {
  it('names a session from the opening message', async () => {
    const model = modelSaying('Refresh token rotation')

    expect(await titleFor({ model, text: 'the refresh token never rotates' })).toBe(
      'Refresh token rotation',
    )
  })

  it('asks nothing of the model when there is nothing to name', async () => {
    const model = modelSaying('Refresh token rotation')

    expect(await titleFor({ model, text: '   ' })).toBeNull()
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it('does not send a pasted file in full to be named', async () => {
    const model = modelSaying('Long paste')
    await titleFor({ model, text: 'x'.repeat(9000) })

    expect(promptTextOf(model).length).toBe(2000)
  })

  it('caps what the model may spend on a name', async () => {
    const model = modelSaying('Refresh token rotation')
    await titleFor({ model, text: 'the refresh token never rotates' })

    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(32)
  })

  it('carries an abort signal so a name cannot outlive the session', async () => {
    const model = modelSaying('Refresh token rotation')
    const controller = new AbortController()
    await titleFor({ model, text: 'rotate the token', signal: controller.signal })

    expect(model.doGenerateCalls[0]?.abortSignal).toBe(controller.signal)
  })

  it('leaves the session unnamed when the model refuses rather than failing the turn', async () => {
    const model = modelRaising(new Error('no credential on this machine'))

    expect(await titleFor({ model, text: 'rotate the token' })).toBeNull()
  })
})
