import { describe, expect, it } from 'bun:test'

import { EMeterBand } from '@dltech/atlas-core'

import { readoutCells, readouts, type FooterContext } from '../footer-layout'
import type { FooterMeter } from '../usage-meters'

const METERS: readonly FooterMeter[] = [
  { label: '5h', band: EMeterBand.Spent, text: '1h31m' },
  { label: 'wk', band: EMeterBand.Normal, text: '12%' },
]

const widest = (context: FooterContext) => readouts(context)[0]

describe('the slot after the context reading', () => {
  it('names the provider when there is no plan behind the model', () => {
    const shown = widest({ percent: 0, tokensUsed: 2_500, provider: 'OpenRouter' })

    expect(shown?.provider).toBe('OpenRouter')
    expect(shown?.meters).toEqual([])
  })

  it('prefers the windows when there is a plan, because they say more', () => {
    const shown = widest({ percent: 0, tokensUsed: 2_500, provider: 'Anthropic', meters: METERS })

    expect(shown?.meters).toEqual(METERS)
    expect(shown?.provider).toBeUndefined()
  })

  it('drops the provider before the reading itself when the terminal is narrow', () => {
    const ladder = readouts({ percent: 0, tokensUsed: 2_500, provider: 'OpenRouter' })
    const last = ladder.at(-1)

    expect(last?.provider).toBeUndefined()
    expect(ladder.some((readout) => readout.provider === 'OpenRouter')).toBe(true)
  })

  it('is narrower once the provider is dropped, so the ladder actually buys room', () => {
    const ladder = readouts({ percent: 0, tokensUsed: 2_500, provider: 'OpenRouter' })
    const named = ladder.find((readout) => readout.provider !== undefined)
    const bare = ladder.at(-1)

    expect(readoutCells({ readout: named! })).toBeGreaterThan(readoutCells({ readout: bare! }))
  })

  it('still names the provider when nothing measured the window', () => {
    const shown = widest({ percent: 0, measured: false, provider: 'OpenRouter' })

    expect(shown?.provider).toBe('OpenRouter')
  })
})
