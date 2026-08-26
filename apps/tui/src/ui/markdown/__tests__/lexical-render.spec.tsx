import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { LEXICAL_LANGUAGES } from '../lexical/languages/index'
import { MarkdownView } from '../markdown-view'
import { rendererFor } from '../registry'
import { teardown } from './harness'

const WIDTH = 60

const FENCE = ['```ruby', '# a note', 'def add(a, b)', '  a + b', 'end', '```'].join('\n')

describe('a lexically highlighted fence', () => {
  it('is claimed by the lexical renderer, not the tree-sitter one', () => {
    expect(rendererFor('ruby').name).toBe('lexical')
    expect(rendererFor('rb').name).toBe('lexical')
    expect(rendererFor('python').name).toBe('code')
  })

  it('routes every registered lexical language, and each of its aliases, to the lexical renderer', () => {
    const misrouted = LEXICAL_LANGUAGES.flatMap((spec) =>
      [spec.filetype, ...(spec.aliases ?? [])]
        .filter((key) => rendererFor(key).name !== 'lexical')
        .map((key) => `${key} -> ${rendererFor(key).name}`),
    )

    expect(misrouted).toEqual([])
  })

  it('leaves a language with a real grammar to the code renderer', () => {
    for (const filetype of ['python', 'typescript', 'c', 'php', 'lua', 'toml', 'json']) {
      expect(rendererFor(filetype).name, `${filetype} was stolen`).toBe('code')
    }
  })

  it('sends a diff to the diff renderer, and a fence with no language to plain', () => {
    expect(rendererFor('diff').name).toBe('diff')
    expect(rendererFor('patch').name).toBe('diff')
    expect(rendererFor('').name).toBe('plain')
  })

  /**
   * `codeRenderer` claims every non-empty language, so an unrecognised one still reaches the code
   * renderable — which draws it unhighlighted rather than refusing it. `plainRenderer` is the
   * fallback only for a fence that carries no language at all.
   */
  it('still routes an unrecognised language to the code renderer, which draws it plain', () => {
    expect(rendererFor('nonesuch').name).toBe('code')
  })

  it('paints colour without waiting for a highlight round trip', async () => {
    const setup = await testRender(
      <box flexDirection="column" width={WIDTH} height={12}>
        <MarkdownView source={FENCE} width={WIDTH - 4} />
      </box>,
      { width: WIDTH, height: 12 },
    )
    try {
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('def add(a, b)')

      const row = setup
        .captureSpans()
        .lines.find((line) => line.spans.some((span) => span.text.includes('def')))
      const colours = new Set((row?.spans ?? []).map((span) => span.fg.toString()))

      expect(colours.size).toBeGreaterThan(2)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
