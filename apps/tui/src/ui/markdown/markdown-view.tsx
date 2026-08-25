import React, { useMemo } from 'react'

import { ALT, glyph, theme } from '../theme'
import { CopyButton } from './copy-button'
import { FencedBlock } from './fenced-block'
import { HorizontalScroller } from './horizontal-scroller'
import { registerFallbackRenderer, registerFencedRenderer } from './registry'
import { codeRenderer, plainRenderer } from './renderers/code'
import { diffRenderer } from './renderers/diff'
import { segmentMarkdown } from './segment'
import { proseSyntaxStyle } from './syntax-style'
import { measureTable, TABLE_OPTIONS } from './table-metrics'

// Registration order is precedence.
registerFencedRenderer(diffRenderer)
registerFencedRenderer(codeRenderer)
registerFallbackRenderer(plainRenderer)

export function MarkdownView(props: {
  source: string
  width: number
  streaming?: boolean
  fg?: string
  bg?: string
}): React.ReactNode {
  const segments = useMemo(() => segmentMarkdown(props.source), [props.source])
  const colours = {
    ...(props.fg === undefined ? {} : { fg: props.fg }),
    ...(props.bg === undefined ? {} : { bg: props.bg }),
  }

  const trailingCaret =
    props.streaming === true && segments[segments.length - 1]?.kind !== 'prose'

  return (
    <box flexDirection="column">
      {segments.map((segment, index) => {
        const live = props.streaming === true && index === segments.length - 1

        return segment.kind === 'table' ? (
          <TableBlock
            key={index}
            markdown={segment.markdown}
            width={props.width}
            streaming={live}
            {...colours}
          />
        ) : segment.kind === 'fence' ? (
          <FencedBlock
            key={index}
            language={segment.language}
            source={segment.source}
            width={props.width}
          />
        ) : (
          <markdown
            key={index}
            content={live ? withCaret(segment.text) : segment.text}
            syntaxStyle={proseSyntaxStyle()}
            width={props.width}
            streaming={live}
            {...colours}
          />
        )
      })}
      {trailingCaret ? <text>{glyph.caret}</text> : null}
    </box>
  )
}

function withCaret(text: string): string {
  return `${text.replace(/\s+$/, '')}${glyph.caret}`
}

function TableBlock(props: {
  markdown: string
  width: number
  streaming?: boolean
  fg?: string
  bg?: string
}): React.ReactNode {
  const metrics = useMemo(() => measureTable(props.markdown), [props.markdown])
  const table = (
    <markdown
      content={props.markdown}
      syntaxStyle={proseSyntaxStyle()}
      tableOptions={TABLE_OPTIONS}
      width={metrics.columns}
      flexShrink={0}
      {...(props.streaming === undefined ? {} : { streaming: props.streaming })}
      {...(props.fg === undefined ? {} : { fg: props.fg })}
      {...(props.bg === undefined ? {} : { bg: props.bg })}
    />
  )

  if (metrics.columns <= props.width) return table

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} marginBottom={1}>
      <HorizontalScroller rows={metrics.rows}>{table}</HorizontalScroller>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.dim}>{`⇄ ${ALT}+wheel · ${metrics.columns} cols`}</text>
        <CopyButton text={props.markdown} />
      </box>
    </box>
  )
}
