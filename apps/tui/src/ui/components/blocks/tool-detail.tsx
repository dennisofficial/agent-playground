/**
 * One renderer per SHAPE of output, chosen by the classification.
 *
 * The point of classifying before rendering is that an opened call stops being a wall of stdout. A
 * search shows its matches as matches, a plan shows its checklist, a test run shows its tally, and
 * only genuinely unstructured output falls through to dim lines.
 */

import { collapseUnchanged } from '@dltech/atlas-core'
import React from 'react'

import type { ToolCall } from '../../../store'
import {
  commandLines,
  detailOf,
  diffOf,
  EDetail,
  outputOf,
  reasonOf,
  records,
  relativise,
  strings,
  targetOf,
} from '../../../store/tools'
import { tailOfPath } from '../../paths'
import { wrapWords } from '../../text-flow'
import { theme } from '../../theme'
import { InlineDiff } from '../diff/inline-diff'
import { CodeLines, codeLinesOf } from './tool-code-lines'
import { ToolCreatedFile } from './tool-created-file'

const DIFF_CONTEXT = 2

const MAX_ROWS = 12

const INDENT = '    '

const PATH_SHARE = 3

function Line(props: { text: string; inner: number; fg: string }): React.ReactNode {
  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      <span fg={props.fg}>
        {`${INDENT}${tailOfPath({ path: props.text, cells: Math.max(8, props.inner - INDENT.length) })}`}
      </span>
    </text>
  )
}

function More(props: { hidden: number; inner: number }): React.ReactNode {
  if (props.hidden <= 0) return null
  return <Line text={`… +${props.hidden} more`} inner={props.inner} fg={theme.rule} />
}

function Output(props: { call: ToolCall; inner: number }): React.ReactNode {
  const body = detailOf(props.call)
  const shown = body.slice(0, MAX_ROWS)

  return (
    <>
      {commandLines(props.call).map((line, index) => (
        <Line key={`c${index}`} text={line} inner={props.inner} fg={theme.code} />
      ))}
      {shown.map((line, index) => (
        <Line key={`d${index}`} text={line} inner={props.inner} fg={theme.hint} />
      ))}
      <More hidden={body.length - shown.length} inner={props.inner} />
    </>
  )
}

/**
 * Why a call never ran, or why it came back an error.
 *
 * Wrapped rather than shortened: this is the sentence the MODEL was handed, and a reason clipped to
 * the width of a path column is a transcript that still cannot say what went wrong.
 */
function Reason(props: { call: ToolCall; inner: number }): React.ReactNode {
  const width = Math.max(8, props.inner - INDENT.length)
  const rows = wrapWords({ text: reasonOf(props.call), width })
  const shown = rows.slice(0, MAX_ROWS)

  return (
    <>
      {shown.map((line, index) => (
        <text key={index} wrapMode="none" width={props.inner} flexShrink={0}>
          <span fg={theme.error}>{`${INDENT}${line}`}</span>
        </text>
      ))}
      <More hidden={rows.length - shown.length} inner={props.inner} />
    </>
  )
}

function FileRead(props: { call: ToolCall; inner: number; cwd: string }): React.ReactNode {
  const body = detailOf(props.call)
  const shown = body.slice(0, MAX_ROWS)
  const named = outputOf(props.call).path
  const path = typeof named === 'string' ? named : (targetOf({ call: props.call, cwd: props.cwd }) ?? '')

  return (
    <>
      <CodeLines lines={codeLinesOf(shown)} path={path} inner={props.inner} indent={INDENT} />
      <More hidden={body.length - shown.length} inner={props.inner} />
    </>
  )
}

function Matches(props: { call: ToolCall; inner: number }): React.ReactNode {
  const found = strings(outputOf(props.call).matches)
  const shown = found.slice(0, MAX_ROWS)

  return (
    <>
      {shown.map((match, index) => {
        const [path, row, ...rest] = match.split(':')
        return (
          <text key={index} wrapMode="none" width={props.inner} flexShrink={0}>
            <span fg={theme.meta}>
              {`${INDENT}${tailOfPath({ path: path ?? '', cells: Math.floor(props.inner / PATH_SHARE) })}`}
            </span>
            <span fg={theme.rule}>{`:${row ?? ''}  `}</span>
            <span fg={theme.hint}>{rest.join(':').trim()}</span>
          </text>
        )
      })}
      <More hidden={found.length - shown.length} inner={props.inner} />
    </>
  )
}

function Paths(props: { call: ToolCall; inner: number; cwd: string }): React.ReactNode {
  const found = strings(outputOf(props.call).paths)
  const shown = found.slice(0, MAX_ROWS)

  return (
    <>
      {shown.map((path, index) => (
        <Line key={index} text={relativise(path, props.cwd)} inner={props.inner} fg={theme.meta} />
      ))}
      <More hidden={found.length - shown.length} inner={props.inner} />
    </>
  )
}

const TASK_GLYPH: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
}

function Plan(props: { call: ToolCall; inner: number }): React.ReactNode {
  return (
    <>
      {records(outputOf(props.call).tasks).map((task, index) => {
        const status = typeof task.status === 'string' ? task.status : 'pending'
        const text = typeof task.text === 'string' ? task.text : ''
        return (
          <text key={index} wrapMode="none" width={props.inner} flexShrink={0}>
            <span fg={status === 'completed' ? theme.ok : theme.rule}>
              {`${INDENT}${TASK_GLYPH[status] ?? '○'} `}
            </span>
            <span fg={status === 'in_progress' ? theme.hover : theme.hint}>{text}</span>
          </text>
        )
      })}
    </>
  )
}

const TALLY = /^\s*\d+\s+(pass|fail|skip|error)/

const FAILING = '(fail)'

function Tests(props: { call: ToolCall; inner: number }): React.ReactNode {
  const body = detailOf(props.call)
  const tally = body.filter((line) => TALLY.test(line))
  const failures = body.filter((line) => line.startsWith(FAILING)).slice(0, MAX_ROWS)

  if (tally.length === 0) return <Output call={props.call} inner={props.inner} />

  return (
    <>
      {failures.map((line, index) => (
        <Line key={`f${index}`} text={line} inner={props.inner} fg={theme.error} />
      ))}
      {tally.map((line, index) => (
        <Line key={`t${index}`} text={line.trim()} inner={props.inner} fg={theme.meta} />
      ))}
    </>
  )
}

const DIFF_INSET = 2

function Diff(props: { call: ToolCall; inner: number; cwd: string }): React.ReactNode {
  const file = diffOf(props.call)
  if (file === null) return null

  return (
    <box marginLeft={DIFF_INSET} marginTop={1}>
      <InlineDiff
        file={{
          ...file,
          path: relativise(file.path, props.cwd),
          hunks: file.hunks.map((hunk) => collapseUnchanged({ hunk, context: DIFF_CONTEXT })),
        }}
        width={Math.max(24, props.inner - DIFF_INSET)}
      />
    </box>
  )
}

export function ToolDetail(props: {
  detail: EDetail
  call: ToolCall
  inner: number
  cwd: string
}): React.ReactNode {
  if (props.detail === EDetail.None) return null
  if (props.detail === EDetail.Diff) {
    return <Diff call={props.call} inner={props.inner} cwd={props.cwd} />
  }
  if (props.detail === EDetail.Created) {
    return <ToolCreatedFile call={props.call} inner={props.inner} cwd={props.cwd} />
  }
  if (props.detail === EDetail.Reason) return <Reason call={props.call} inner={props.inner} />
  if (props.detail === EDetail.File) {
    return <FileRead call={props.call} inner={props.inner} cwd={props.cwd} />
  }
  if (props.detail === EDetail.Matches) return <Matches call={props.call} inner={props.inner} />
  if (props.detail === EDetail.Paths) {
    return <Paths call={props.call} inner={props.inner} cwd={props.cwd} />
  }
  if (props.detail === EDetail.Plan) return <Plan call={props.call} inner={props.inner} />
  if (props.detail === EDetail.Tests) return <Tests call={props.call} inner={props.inner} />
  return <Output call={props.call} inner={props.inner} />
}
