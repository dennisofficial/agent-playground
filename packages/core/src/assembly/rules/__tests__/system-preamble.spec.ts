import { describe, expect, it } from 'bun:test'

import { EToolEffect, type ToolDeclaration } from '../../../tools/tool'
import { z } from 'zod'

import type { Assembled } from '../../assembled'
import { contextFor, log } from '../../__tests__/log-fixture'
import { MINIMAL_PREAMBLE, systemPreamble } from '../system-preamble'

const ctx = contextFor({ events: log([]) })

describe('systemPreamble', () => {
  it('appends one system block holding the minimal preamble', () => {
    const assembled = systemPreamble()({ system: [], messages: [] }, ctx)

    expect(assembled.system).toEqual([{ text: MINIMAL_PREAMBLE }])
  })

  it('leaves messages and earlier system blocks alone', () => {
    const input: Assembled = {
      system: [{ text: 'earlier' }],
      messages: [
        {
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          origin: { eventId: log([{ type: 'user-said', text: 'hello' }])[0]!.id, seq: 1 },
        },
      ],
    }

    const assembled = systemPreamble()(input, ctx)

    expect(assembled.system.map((block) => block.text)).toEqual(['earlier', MINIMAL_PREAMBLE])
    expect(assembled.messages).toEqual(input.messages)
  })

  it('claims no tools, rather than claiming there are none', () => {
    const assembled = systemPreamble()({ system: [], messages: [] }, ctx)

    expect(assembled.system[0]?.text).not.toContain('no tools')
  })
})

const declaration = (name: string): ToolDeclaration => ({
  name,
  description: `the ${name} tool`,
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string() }),
})

describe('systemPreamble over a workspace', () => {
  const preamble = (): string =>
    systemPreamble({
      root: '/Users/dev/project',
      tools: [declaration('read'), declaration('write'), declaration('bash')],
    })({ system: [], messages: [] }, ctx).system[0]?.text ?? ''

  it('states the workspace root the tools resolve against', () => {
    expect(preamble()).toContain('/Users/dev/project')
  })

  it('names every tool the registry declared, in the order it declared them', () => {
    expect(preamble()).toContain('read, write, bash')
  })

  it('keeps the identity it opens with', () => {
    expect(preamble().startsWith(MINIMAL_PREAMBLE)).toBe(true)
  })

  it('appends one system block and nothing more', () => {
    const assembled = systemPreamble({ root: '/w', tools: [] })({ system: [{ text: 'earlier' }], messages: [] }, ctx)

    expect(assembled.system).toHaveLength(2)
    expect(assembled.system[0]?.text).toBe('earlier')
  })
})
