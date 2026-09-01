import React from 'react'

import type { ToolCall } from '../../../store'
import { hostOf, num, outputOf, records, str } from '../../../store/tools'
import { wrapWords } from '../../text-flow'
import { theme } from '../../theme'
import { MoreToggle, shownOf, type Expander } from './more-toggle'

const INDENT = '    '

const MAX_ROWS = 12

const MAX_RESULTS = 6

const SNIPPET_ROWS = 2

const kilobytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`

function Row(props: { children: React.ReactNode; inner: number }): React.ReactNode {
  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      {props.children}
    </text>
  )
}

/**
 * A fetched page leads with what it is rather than where it came from: the row above already carries
 * the host, so repeating it here would spend the widest line in the block on a word already read.
 */
export function ToolPage(props: {
  call: ToolCall
  inner: number
  expand: Expander
}): React.ReactNode {
  const output = outputOf(props.call)
  const title = str(output.title)
  const bytes = num(output.bytes)
  const pattern = str(output.pattern)
  const body = (str(output.body) ?? '').split('\n').filter((line) => line.trim().length > 0)
  const shown = shownOf({ body, cap: MAX_ROWS, expand: props.expand })
  const cells = Math.max(8, props.inner - INDENT.length)

  return (
    <>
      {title === undefined ? null : (
        <Row inner={props.inner}>
          <span fg={theme.hover}>{`${INDENT}${title.slice(0, cells)}`}</span>
        </Row>
      )}
      <Row inner={props.inner}>
        <span fg={theme.rule}>{INDENT}</span>
        <span fg={theme.meta}>{hostOf(str(output.finalUrl) ?? '')}</span>
        {bytes === undefined ? null : <span fg={theme.rule}>{`  ${kilobytes(bytes)}`}</span>}
        {pattern === undefined ? null : <span fg={theme.hover}>{`  /${pattern}/`}</span>}
        {output.truncated === true ? <span fg={theme.rule}>{'  cut'}</span> : null}
      </Row>
      {shown.map((line, index) => (
        <Row key={index} inner={props.inner}>
          <span fg={theme.hint}>{`${INDENT}${line.slice(0, cells)}`}</span>
        </Row>
      ))}
      <MoreToggle
        hidden={body.length - MAX_ROWS}
        indent={INDENT}
        width={props.inner}
        expand={props.expand}
      />
    </>
  )
}

export function ToolResults(props: {
  call: ToolCall
  inner: number
  expand: Expander
}): React.ReactNode {
  const results = records(outputOf(props.call).results)
  const shown = shownOf({ body: [...results], cap: MAX_RESULTS, expand: props.expand })
  const cells = Math.max(8, props.inner - INDENT.length)

  return (
    <>
      {shown.map((result, index) => {
        const snippet = str(result['snippet']) ?? str(result['content'])
        const lines =
          snippet === undefined
            ? []
            : wrapWords({ text: snippet, width: cells - 3 }).slice(0, SNIPPET_ROWS)

        return (
          <React.Fragment key={index}>
            <Row inner={props.inner}>
              <span fg={theme.rule}>{`${INDENT}${index + 1}. `}</span>
              <span fg={theme.hover}>{(str(result['title']) ?? '').slice(0, cells - 4)}</span>
            </Row>
            <Row inner={props.inner}>
              <span fg={theme.meta}>{`${INDENT}   ${hostOf(str(result['url']) ?? '')}`}</span>
            </Row>
            {lines.map((line, row) => (
              <Row key={row} inner={props.inner}>
                <span fg={theme.hint}>{`${INDENT}   ${line}`}</span>
              </Row>
            ))}
          </React.Fragment>
        )
      })}
      <MoreToggle
        hidden={results.length - MAX_RESULTS}
        indent={INDENT}
        width={props.inner}
        expand={props.expand}
      />
    </>
  )
}
