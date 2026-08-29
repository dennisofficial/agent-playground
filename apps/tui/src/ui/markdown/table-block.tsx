import React, { useMemo } from 'react'

import { ALT, theme } from '../theme'
import { CopyButton } from './copy-button'
import { HorizontalScroller } from './horizontal-scroller'
import { proseSyntaxStyle } from './syntax-style'
import { measureTable, TABLE_OPTIONS } from './table-metrics'

/**
 * `streaming` is not decoration on the renderable — it is what stops @opentui 0.4.5's incremental
 * parser from freezing the table. `parseMarkdownIncremental` keeps every token whose `raw` is still
 * a prefix of the new content and lexes only the remainder; with streaming off it holds back nothing
 * (`trailingUnstable` is 0), so the half-arrived table token is kept and each new row lexes alone,
 * as a paragraph drawn beneath the box. Streaming leaves the trailing tokens unstable, which is the
 * whole table here, so every delta re-lexes the table entire.
 */
export function TableBlock(props: {
  markdown: string
  width: number
  streaming?: boolean
  fg?: string
  bg?: string
}): React.ReactNode {
  const metrics = useMemo(() => measureTable(props.markdown), [props.markdown])
  const content = useMemo(() => upperHeader(props.markdown), [props.markdown])
  const table = (
    <markdown
      content={content}
      streaming={props.streaming === true}
      syntaxStyle={proseSyntaxStyle()}
      tableOptions={TABLE_OPTIONS}
      width={metrics.columns}
      flexShrink={0}
      {...(props.fg === undefined ? {} : { fg: props.fg })}
      {...(props.bg === undefined ? {} : { bg: props.bg })}
    />
  )

  if (metrics.columns <= props.width) {
    return (
      <box flexDirection="column" flexShrink={0} marginBottom={1}>
        {table}
      </box>
    )
  }

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} marginBottom={1}>
      <HorizontalScroller rows={metrics.rows} columns={metrics.columns} width={props.width}>
        {table}
      </HorizontalScroller>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.dim}>{`⇄ ${ALT}+wheel`}</text>
        <CopyButton text={props.markdown} />
      </box>
    </box>
  )
}

function upperHeader(markdown: string): string {
  const lines = markdown.split('\n')
  const header = lines[0]
  if (header === undefined) return markdown
  return [header.toUpperCase(), ...lines.slice(1)].join('\n')
}
