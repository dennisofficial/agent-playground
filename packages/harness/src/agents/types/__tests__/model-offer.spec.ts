import { describe, expect, it } from 'bun:test'

import { modelsWorthOffering, offerSentence } from '../model-offer'

const CATALOGUE_SIZED_LIKE_A_GATEWAY = Array.from(
  { length: 340 },
  (_, at) => `vendor-${at}/model-${at}`,
)

describe('the models a refusal offers instead', () => {
  it('caps the enumeration, because a gateway catalogue is hundreds long', () => {
    const { offered, withheld } = modelsWorthOffering({
      modelId: 'nothing-like-any-of-them',
      reachable: CATALOGUE_SIZED_LIKE_A_GATEWAY,
    })

    expect(offered).toHaveLength(8)
    expect(withheld).toBe(332)
  })

  it('leads with what the operator was reaching for rather than the head of the list', () => {
    const { offered } = modelsWorthOffering({
      modelId: 'anthropic/claude-haiku-45',
      reachable: [
        'openai/gpt-5-codex',
        'anthropic/claude-haiku-4-5',
        'anthropic/claude-opus-5',
        'google/gemini-3-pro',
      ],
    })

    expect(offered[0]).toBe('anthropic/claude-haiku-4-5')
  })

  it('offers a model whose id contains what was typed, however the two are spelled', () => {
    const { offered } = modelsWorthOffering({
      modelId: 'claude-opus-5',
      reachable: ['openai/gpt-5-codex', 'anthropic/claude-opus-5'],
    })

    expect(offered[0]).toBe('anthropic/claude-opus-5')
  })

  it('withholds nothing when the whole list fits', () => {
    const { offered, withheld } = modelsWorthOffering({
      modelId: 'typo',
      reachable: ['a/one', 'b/two'],
    })

    expect(offered).toEqual(['a/one', 'b/two'])
    expect(withheld).toBe(0)
  })

  it('counts the rest rather than printing it', () => {
    const sentence = offerSentence({
      offer: modelsWorthOffering({
        modelId: 'typo',
        reachable: CATALOGUE_SIZED_LIKE_A_GATEWAY,
      }),
      lead: 'Pin one of:',
      whenNothingIsReachable: 'No model is reachable, so pin none.',
    })

    expect(sentence).toContain('and 332 more.')
    expect(sentence.length).toBeLessThan(400)
  })

  it('says so plainly when this build can reach nothing at all', () => {
    const sentence = offerSentence({
      offer: modelsWorthOffering({ modelId: 'typo', reachable: [] }),
      lead: 'Pin one of:',
      whenNothingIsReachable: 'No model is reachable, so pin none.',
      then: 'never reached',
    })

    expect(sentence).toBe('No model is reachable, so pin none.')
  })
})
