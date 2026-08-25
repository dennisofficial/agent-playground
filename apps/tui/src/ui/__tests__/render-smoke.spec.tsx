import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Screen } from '../components/screen'
import { Spans } from '../components/spans'
import { MarkdownView } from '../markdown/markdown-view'
import { grammarsReady, teardown } from '../markdown/__tests__/harness'
import { theme } from '../theme'

/**
 * Every ported surface, mounted for real at several terminal widths.
 *
 * OpenTUI's `<text>` accepts strings, text nodes and styled text — NOT nested `<text>` elements. A
 * component that returns `<text>` and is rendered inside another `<text>` therefore throws at mount,
 * and nothing in the type system catches it: the nesting only exists once the component has been
 * expanded. That shipped twice during the previous migration, both times found by a user opening a
 * page. Mounting here turns it into a test failure instead.
 */

await grammarsReady()

const WIDTHS = [24, 40, 60, 100, 200] as const

const DOCUMENTS: Record<string, string> = {
  headings: ['# one', '## two', '### three', '#### four', '##### five', '###### six'].join('\n\n'),
  prose: 'Some prose with **bold**, _italic_, `inline code` and a [link](https://example.com).',
  lists: ['- one', '- two', '  - nested', '', '1. first', '2. second', '', '- [x] done', '- [ ] not'].join(
    '\n',
  ),
  quote: '> someone else said this\n>\n> over two paragraphs',
  table: [
    '| Engine | Model | Notes |',
    '| --- | --- | --- |',
    '| claude | opus | a much longer note that pushes this table well past sixty columns |',
    '| codex | gpt | short |',
  ].join('\n'),
  labelledFence: ['```ts', 'const x: number = 1;', '// a comment', 'export { x };', '```'].join(
    '\n',
  ),
  unlabelledFence: '```\nno language here\n```',
  wideFence: ['```ts', `const wide = ${"'x'".repeat(60)};`, '```'].join('\n'),
  diffFence: [
    '```diff',
    'diff --git a/a.ts b/a.ts',
    '@@ -1,2 +1,2 @@',
    '-const x = 1;',
    '+const x = 2;',
    ' const y = 3;',
    '```',
  ].join('\n'),
  vendoredGrammars: [
    '```python',
    'def greet(name: str) -> str:\n    return f"hi {name}"',
    '```',
    '',
    '```sql',
    'SELECT id FROM sessions WHERE ended_at IS NULL;',
    '```',
    '',
    '```yaml',
    'name: atlas\nitems:\n  - one',
    '```',
  ].join('\n'),
  mixed: [
    '## A heading',
    '',
    'Prose either side of a fence.',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    'Trailing prose.',
  ].join('\n'),
  quotedFence: '> ```ts\n> const nested = 1;\n> ```',
  empty: '',
}

async function mount(node: React.ReactNode, width: number): Promise<void> {
  const setup = await testRender(
    <box flexDirection="column" width={width} height={30}>
      {node}
    </box>,
    { width, height: 30 },
  )
  try {
    await setup.flush()
  } finally {
    await teardown(setup)
  }
}

describe('the markdown surface mounts', () => {
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    it(`renders ${name} at every width`, async () => {
      for (const width of WIDTHS) {
        await expect(
          mount(<MarkdownView source={source} width={Math.max(4, width - 4)} />, width),
        ).resolves.toBeUndefined()
      }
    }, 120_000)
  }

  it('renders every document while streaming, caret and all', async () => {
    for (const source of Object.values(DOCUMENTS)) {
      await expect(
        mount(<MarkdownView source={source} width={56} streaming />, 60),
      ).resolves.toBeUndefined()
    }
  }, 120_000)

  it('renders over a host slab, where prose has to paint its own background', async () => {
    await expect(
      mount(
        <MarkdownView
          source={DOCUMENTS.mixed ?? ''}
          width={56}
          fg={theme.harnessFg}
          bg={theme.harnessBg}
        />,
        60,
      ),
    ).resolves.toBeUndefined()
  }, 30_000)
})

describe('the ported components mount', () => {
  it('renders a screen with a header and a footer around markdown', async () => {
    await expect(
      mount(
        <Screen header={<text>header</text>} footer={<text>footer</text>}>
          <MarkdownView source={DOCUMENTS.mixed ?? ''} width={56} />
        </Screen>,
        60,
      ),
    ).resolves.toBeUndefined()
  }, 30_000)

  it('renders spans inside a text, which is the only place they are legal', async () => {
    await expect(
      mount(
        <text>
          <Spans spans={[{ text: 'a ' }, { text: 'coloured', fg: theme.accent }, { text: ' run' }]} />
        </text>,
        60,
      ),
    ).resolves.toBeUndefined()
  }, 30_000)
})
