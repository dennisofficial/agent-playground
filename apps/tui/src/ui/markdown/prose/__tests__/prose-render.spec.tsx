import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { theme } from '../../../theme'
import { grammarsReady, teardown } from '../../__tests__/harness'
import { ProseView } from '../prose-view'

/**
 * Every claim here is one the scope table could not make: `SyntaxStyle` has no strikethrough, no
 * glyph substitution and no way to draw a row of its own, and the shipped tree-sitter queries
 * conceal none of the markers asserted absent below.
 */

await grammarsReady()

const WIDTH = 48

async function mount(source: string) {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={30}>
      <ProseView source={source} width={WIDTH} />
    </box>,
    { width: WIDTH, height: 30 },
  )
  await setup.flush()
  return setup
}

async function frame(source: string): Promise<string> {
  const setup = await mount(source)
  try {
    return setup.captureCharFrame()
  } finally {
    await teardown(setup)
  }
}

async function inks(source: string): Promise<Map<string, string>> {
  const setup = await mount(source)
  try {
    const out = new Map<string, string>()
    for (const line of setup.captureSpans().lines) {
      for (const span of line.spans) {
        const text = span.text.trim()
        if (text.length === 0 || out.has(text)) continue
        const hex = [span.fg.r, span.fg.g, span.fg.b]
          .map((c) =>
            Math.round(c * 255)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('')
        out.set(text, `#${hex}`)
      }
    }
    return out
  } finally {
    await teardown(setup)
  }
}

describe('headings', () => {
  it('ranks the six levels by lightness, spending the accent on h2 alone', async () => {
    const ink = await inks('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six')

    expect(ink.get('One')).toBe(theme.userFg)
    expect(ink.get('Two')).toBe(theme.accent)
    expect(ink.get('Three')).toBe(theme.hover)
    expect(ink.get('Four')).toBe(theme.meta)
    expect(ink.get('Five')).toBe(theme.meta)
    expect(ink.get('Six')).toBe(theme.hint)
  })

  it('rules under an h1 across the content, and under nothing else', async () => {
    const under = (await frame('# One\n\n## Two')).split('\n')
    expect(under[1]?.trimEnd()).toBe('─'.repeat(WIDTH))
    expect(under[3]).not.toContain('─')
  })
})

describe('lists', () => {
  it('draws a bullet that changes with depth and a bare ordinal that does not carry a dot', async () => {
    const drawn = await frame('- one\n  - deep\n\n1. first\n   1. under')

    expect(drawn).toContain('• one')
    expect(drawn).toContain('◦ deep')
    expect(drawn).toContain(' 1 first')
    expect(drawn).toContain(' a under')
    expect(drawn).not.toContain('1.')
    expect(drawn).not.toContain('- ')
  })

  it('replaces a task box with a glyph rather than printing the brackets', async () => {
    const drawn = await frame('- [x] done\n- [ ] todo')

    expect(drawn).toContain('✓ done')
    expect(drawn).toContain('○ todo')
    expect(drawn).not.toContain('[x]')
    expect(drawn).not.toContain('[ ]')
  })
})

describe('blockquotes', () => {
  it('stacks one rail per level, lightening outward, and prints no > at any level', async () => {
    const drawn = await frame('> one\n>\n> > two\n> >\n> > > three')
    const ink = await inks('> one\n>\n> > two\n> >\n> > > three')

    expect(drawn).toContain('▌  one')
    expect(drawn).toContain('▌▌  two')
    expect(drawn).toContain('▌▌▌  three')
    expect(drawn).not.toContain('>')
    expect(ink.get('▌')).toBe(theme.hint)
    expect(ink.get('one')).toBe(theme.meta)
  })
})

describe('rules and footnotes', () => {
  it('draws a thematic break across the whole content width', async () => {
    const drawn = (await frame('a\n\n---\n\nb')).split('\n')
    const rule = drawn.find((line) => line.includes('─'))
    expect(rule?.trimEnd()).toBe('─'.repeat(WIDTH))
  })

  it('numbers a reference in place and collects the note under a short rule', async () => {
    const drawn = await frame('see[^1].\n\n[^1]: the note')

    expect(drawn).toContain('see¹.')
    expect(drawn).toContain('─'.repeat(8))
    expect(drawn).toContain('¹ the note')
    expect(drawn).not.toContain('[^1]')
  })
})

describe('inline syntax', () => {
  it('leaves no marker, url, escape or comment on screen', async () => {
    const drawn = await frame(
      '`code` and [OpenAI](https://openai.com/a/b "T") and \\*kept\\* and ~~gone~~\n\n<!-- hush -->',
    )

    expect(drawn).toContain('OpenAI openai.com ↗')
    expect(drawn).toContain('*kept*')
    expect(drawn).not.toContain('https://')
    expect(drawn).not.toContain('\\')
    expect(drawn).not.toContain('hush')
    expect(drawn).not.toContain('~~')
    expect(drawn).not.toContain('`')
  })

  it('never strands a lit cell of the slab at a wrap', async () => {
    for (let filler = 20; filler <= WIDTH; filler += 1) {
      const setup = await mount(`${'w'.repeat(filler)} \`useFactory\` collector above is idiomatic.`)
      try {
        const stranded = setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .filter(
            (span) =>
              span.text.trim().length === 0 && Math.round(span.bg.r * 255) === 0x33,
          )
        expect(stranded).toEqual([])
      } finally {
        await teardown(setup)
      }
    }
  }, 60_000)

  it('slabs inline code and tints it accent, so an identifier is findable mid-paragraph', async () => {
    const setup = await mount('`a()` and `b()` and `c()` and `d()`')
    try {
      const painted = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.text.trim().length > 0)

      const slabbed = painted.filter((span) => Math.round(span.bg.r * 255) === 0x33)
      expect(slabbed.length).toBeGreaterThan(0)
      for (const span of slabbed) {
        expect(Math.round(span.fg.r * 255)).toBe(0xd9)
      }

      for (const span of painted.filter((span) => Math.round(span.bg.r * 255) !== 0x33)) {
        expect(Math.round(span.fg.r * 255)).not.toBe(0xd9)
      }
    } finally {
      await teardown(setup)
    }
  })

  it('leaves struck code de-emphasised rather than accent, as struck prose is', async () => {
    const setup = await mount('~~`gone()`~~')
    try {
      const painted = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.text.trim().length > 0)

      for (const span of painted) {
        expect(Math.round(span.fg.r * 255)).not.toBe(0xd9)
      }
    } finally {
      await teardown(setup)
    }
  })
})
