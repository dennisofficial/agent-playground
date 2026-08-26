import React, { useMemo } from 'react'

import { ALT, theme } from '../theme'
import { CopyButton } from './copy-button'
import { HorizontalScroller } from './horizontal-scroller'
import { proseSyntaxStyle } from './syntax-style'
import { measureTable, TABLE_OPTIONS } from './table-metrics'

export function TableBlock(props: {
  markdown: string
  width: number
  fg?: string
  bg?: string
}): React.ReactNode {
  const metrics = useMemo(() => measureTable(props.markdown), [props.markdown])
  const content = useMemo(() => upperHeader(props.markdown), [props.markdown])
  const table = (
    <markdown
      content={content}
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
      <HorizontalScroller rows={metrics.rows}>{table}</HorizontalScroller>
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
