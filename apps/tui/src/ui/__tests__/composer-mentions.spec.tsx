import { parseColor } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Composer } from '../components/composer'
import { useDraft } from '../hooks/use-draft'
import { grammarsReady, settle, teardown } from '../markdown/__tests__/harness'
import { theme } from '../theme'
import { drawn, HEIGHT } from './transcript-fixture'

await grammarsReady()

const WIDTH = 60

const SAID = 'why is @src/app.ts broken'

type Colour = { equals: (other: unknown) => boolean }

type Span = { text: string; fg: Colour }

type Spans = { lines: ({ spans: Span[] } | undefined)[] }

function Draft(props: {
  text: string
  highlights?: readonly { start: number; end: number }[]
}): React.ReactNode {
  const draft = useDraft(props.text)
  return (
    <Composer
      draft={draft}
      width={WIDTH}
      {...(props.highlights === undefined ? {} : { highlights: props.highlights })}
    />
  )
}

const foregroundOf = ({
  spans,
  row,
  text,
}: {
  spans: Spans
  row: number
  text: string
}): Colour | null => {
  for (const span of spans.lines[row]?.spans ?? []) {
    if (span.text.includes(text)) return span.fg
  }
  return null
}

async function paintedOn(node: React.ReactNode): Promise<{ spans: Spans; row: number }> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      {node}
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  try {
    const rows = (await drawn(setup)).split('\n')
    return {
      spans: setup.captureSpans() as Spans,
      row: rows.findIndex((one) => one.includes('broken')),
    }
  } finally {
    await teardown(setup)
  }
}

async function paintedAfterTyping(args: {
  node: React.ReactNode
  typed: string
}): Promise<{ spans: Spans; row: number }> {
  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      {args.node}
    </box>,
    { width: WIDTH, height: HEIGHT },
  )
  try {
    await drawn(setup)
    await setup.mockInput.typeText(args.typed)
    await settle(80)
    await setup.flush()

    const rows = (await drawn(setup)).split('\n')
    return {
      spans: setup.captureSpans() as Spans,
      row: rows.findIndex((one) => one.includes(args.typed.trim())),
    }
  } finally {
    await teardown(setup)
  }
}

describe('a composer that was given mention spans', () => {
  it('paints the mention in the mention colour', async () => {
    const { spans, row } = await paintedOn(
      <Draft text={SAID} highlights={[{ start: 7, end: 18 }]} />,
    )

    expect(foregroundOf({ spans, row, text: '@src/app.ts' })?.equals(parseColor(theme.link))).toBe(
      true,
    )
  })

  it('leaves the prose around it in the draft colour', async () => {
    const { spans, row } = await paintedOn(
      <Draft text={SAID} highlights={[{ start: 7, end: 18 }]} />,
    )

    expect(foregroundOf({ spans, row, text: 'why is' })?.equals(parseColor(theme.userFg))).toBe(
      true,
    )
  })

  it('lands the paint on the right characters below a line break', async () => {
    const twoLines = 'first line\nwhy is @src/app.ts broken'
    const start = twoLines.indexOf('@')

    const { spans, row } = await paintedOn(
      <Draft text={twoLines} highlights={[{ start, end: start + '@src/app.ts'.length }]} />,
    )

    expect(foregroundOf({ spans, row, text: '@src/app.ts' })?.equals(parseColor(theme.link))).toBe(
      true,
    )
    expect(foregroundOf({ spans, row, text: 'why is' })?.equals(parseColor(theme.userFg))).toBe(
      true,
    )
  })

  it('does not grow the paint over what is typed after the mention', async () => {
    const { spans, row } = await paintedAfterTyping({
      node: <Draft text="@a.ts" highlights={[{ start: 0, end: 5 }]} />,
      typed: ' and more prose',
    })

    expect(foregroundOf({ spans, row, text: 'and more prose' })?.equals(parseColor(theme.link))).toBe(
      false,
    )
    expect(foregroundOf({ spans, row, text: '@a.ts' })?.equals(parseColor(theme.link))).toBe(true)
  })

  it('paints nothing when it was given nothing', async () => {
    const { spans, row } = await paintedOn(<Draft text={SAID} />)

    expect(foregroundOf({ spans, row, text: '@src/app.ts' })?.equals(parseColor(theme.link))).toBe(
      false,
    )
  })
})
