import { describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import React from 'react'

import type { ToolCall } from '../../../../store'
import { NOT_EXPANDABLE } from '../more-toggle'
import { ToolPage, ToolResults } from '../tool-web'

const call = (args: { name: string; input: unknown; output: unknown }): ToolCall =>
  ({
    callId: 'call-1',
    name: args.name,
    input: args.input,
    output: args.output,
    settled: true,
    failed: false,
  }) as unknown as ToolCall

const frameOf = async (node: React.ReactNode): Promise<string> => {
  const { renderOnce, captureCharFrame } = await testRender(node, { width: 64, height: 24 })
  await renderOnce()
  return captureCharFrame()
}

describe('an opened web_fetch', () => {
  test('leads with the title and says where and how big', async () => {
    const frame = await frameOf(
      <ToolPage
        call={call({
          name: 'web_fetch',
          input: { url: 'https://bun.com/docs/runtime/glob' },
          output: {
            finalUrl: 'https://bun.com/docs/runtime/glob',
            title: 'Glob | Bun Docs',
            bytes: 4036,
            body: '# Glob\n\nUse the native implementation of file globbing.',
            truncated: false,
          },
        })}
        inner={60}
        expand={NOT_EXPANDABLE}
      />,
    )

    expect(frame).toContain('Glob | Bun Docs')
    expect(frame).toContain('bun.com/docs/runtime/glob')
    expect(frame).toContain('4 KB')
    expect(frame).toContain('Use the native implementation')
  })

  test('shows the pattern, so an excerpt is never mistaken for the whole page', async () => {
    const frame = await frameOf(
      <ToolPage
        call={call({
          name: 'web_fetch',
          input: { url: 'https://bun.com/docs', pattern: 'scanSync' },
          output: {
            finalUrl: 'https://bun.com/docs',
            bytes: 300,
            body: 'scanSync(root)',
            truncated: false,
            pattern: 'scanSync',
            matched: 1,
          },
        })}
        inner={60}
        expand={NOT_EXPANDABLE}
      />,
    )

    expect(frame).toContain('/scanSync/')
  })

  test('says so when the page was cut rather than pretending it was whole', async () => {
    const frame = await frameOf(
      <ToolPage
        call={call({
          name: 'web_fetch',
          input: { url: 'https://example.com/long' },
          output: {
            finalUrl: 'https://example.com/long',
            bytes: 900_000,
            body: 'a long page',
            truncated: true,
          },
        })}
        inner={60}
        expand={NOT_EXPANDABLE}
      />,
    )

    expect(frame).toContain('cut')
  })
})

describe('an opened web_search', () => {
  test('numbers the results and shows each url under its title', async () => {
    const frame = await frameOf(
      <ToolResults
        call={call({
          name: 'web_search',
          input: { query: 'bun glob' },
          output: {
            query: 'bun glob',
            backend: 'duckduckgo',
            results: [
              {
                title: 'Glob | Bun Docs',
                url: 'https://bun.com/docs/runtime/glob',
                snippet: 'Native globbing.',
              },
              {
                title: 'Bun Glob class',
                url: 'https://bun.com/reference/bun/Glob',
                snippet: 'Match files.',
              },
            ],
          },
        })}
        inner={60}
        expand={NOT_EXPANDABLE}
      />,
    )

    expect(frame).toContain('1.')
    expect(frame).toContain('Glob | Bun Docs')
    expect(frame).toContain('bun.com/docs/runtime/glob')
    expect(frame).toContain('Native globbing.')
    expect(frame).toContain('2.')
    expect(frame).toContain('Bun Glob class')
  })

  test('renders a result that carries no snippet at all', async () => {
    const frame = await frameOf(
      <ToolResults
        call={call({
          name: 'web_search',
          input: { query: 'x' },
          output: {
            query: 'x',
            backend: 'exa',
            results: [{ title: 'Bare', url: 'https://a.test/page' }],
          },
        })}
        inner={60}
        expand={NOT_EXPANDABLE}
      />,
    )

    expect(frame).toContain('Bare')
    expect(frame).toContain('a.test/page')
  })
})
