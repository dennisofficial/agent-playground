import { describe, expect, it } from 'bun:test'
import React from 'react'

import { WelcomeScreen } from '../components/welcome-screen'
import { grammarsReady } from '../markdown/__tests__/harness'
import { theme } from '../theme'
import { wordmarkRows, WORDMARK_CELLS } from '../wordmark'
import { CWD, HOME, MODEL_ID, frameOf } from './transcript-fixture'

await grammarsReady()

const WIDE = WORDMARK_CELLS + 20

const HALF_CELL = '\u2580'

const screen = (width: number): React.ReactNode => (
  <WelcomeScreen cwd={CWD} home={HOME} modelId={MODEL_ID} width={width} />
)

describe('the welcome screen', () => {
  it('names itself, where it is and what answers', async () => {
    const frame = await frameOf(screen(WIDE), WIDE)

    expect(frame).toContain('~/Developer/atlas')
    expect(frame).toContain(MODEL_ID)
    expect(frame).toContain('Describe the work')
  })

  it('centres the wordmark rather than hanging it off the left edge', async () => {
    const rows = (await frameOf(screen(WIDE), WIDE)).split('\n')
    const inked = rows.filter((row) => row.trim().length > 0 && row.startsWith(' '))

    expect(inked.length).toBeGreaterThan(0)
  })

  it('holds every row of the mark on one shared left edge', async () => {
    const pad = Math.floor((WIDE - WORDMARK_CELLS) / 2)
    const painted = (await frameOf(screen(WIDE), WIDE))
      .split('\n')
      .map((row) => row.indexOf(HALF_CELL))
      .filter((column) => column >= 0)
    const modelled = wordmarkRows({
      accent: theme.accent,
      ground: theme.appBg,
      bright: theme.bright,
    })
      .map((row) => {
        const inked = row.findIndex((span) => span.text.includes(HALF_CELL))
        if (inked < 0) return -1
        return row.slice(0, inked).reduce((total, span) => total + span.text.length, 0)
      })
      .filter((column) => column >= 0)

    expect(painted).toHaveLength(modelled.length)
    expect(painted.map((column) => column - pad)).toEqual(modelled)
  })

  it('falls back to a one-line mark when the terminal is too narrow to carry the art', async () => {
    const narrow = WORDMARK_CELLS - 10
    const frame = await frameOf(screen(narrow), narrow)

    expect(frame).toContain('atlas')
  })
})
