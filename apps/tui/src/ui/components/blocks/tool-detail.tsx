/**
 * One renderer per SHAPE of output, chosen by the classification.
 *
 * The point of classifying before rendering is that an opened call stops being a wall of stdout. A
 * search shows its matches as matches, a plan shows its checklist, a test run shows its tally, and
 * only genuinely unstructured output falls through to dim lines.
 */

import { collapseUnchanged } from '@dltech/atlas-core'
import React, { useMemo } from 'react'

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
import { stripAnsi } from '../../ansi'
import { tailOfPath } from '../../paths'
import { wrapWords } from '../../text-flow'
import { theme } from '../../theme'
import { InlineDiff } from '../diff/inline-diff'
import { MoreToggle, NOT_EXPANDABLE, shownOf, type Expander } from './more-toggle'
import { CodeLines, codeLinesOf } from './tool-code-lines'
import { ToolCreatedFile } from './tool-created-file'
import { ToolImage } from './tool-image'
import { ToolTerminal } from './tool-terminal'
import { ToolPage, ToolResults } from './tool-web'

export const DIFF_CONTEXT = 2

const MAX_ROWS = 12

const INDENT = '    '

const PATH_SHARE = 3

const detailLine = (args: { text: string; inner: number }): string =>
  `${INDENT}${tailOfPath({ path: stripAnsi(args.text), cells: Math.max(8, args.inner - INDENT.length) })}`

type LineGroup = { fg: string; lines: readonly string[] }

/**
 * A block of same-shaped rows as ONE <text> with a span per colour group — the rows a per-line
 * loop used to spend a renderable each on. Every renderable still mounted is repainted every
 * frame, so a twelve-row detail is one repaint here, not twelve.
 */
function JoinedLines(props: { inner: number; groups: readonly LineGroup[] }): React.ReactNode {
  const groups = props.groups.filter((group) => group.lines.length > 0)
  if (groups.length === 0) return null

  return (
    <text wrapMode="none" width={props.inner} flexShrink={0}>
      {groups.flatMap((group, index) => {
        const span = (
          <span key={index} fg={group.fg}>
            {group.lines.join('\n')}
          </span>
        )
        return index === 0 ? [span] : ['\n', span]
      })}
    </text>
  )
}

function More(props: { hidden: number; inner: number; expand: Expander }): React.ReactNode {
  return (
    <MoreToggle hidden={props.hidden} indent={INDENT} width={props.inner} expand={props.expand} />
  )
}

function Output(props: { call: ToolCall; inner: number; expand: Expander }): React.ReactNode {
  const body = detailOf(props.call)
  const shown = shownOf({ body, cap: MAX_ROWS, expand: props.expand })

  return (
    <>
      <JoinedLines
        inner={props.inner}
        groups={[
          {
            fg: theme.code,
            lines: commandLines(props.call).map((line) =>
              detailLine({ text: line, inner: props.inner }),
            ),
          },
          {
            fg: theme.hint,
            lines: shown.map((line) => detailLine({ text: line, inner: props.inner })),
          },
        ]}
      />
      <More hidden={body.length - MAX_ROWS} inner={props.inner} expand={props.expand} />
    </>
  )
}

/**
 * Why a call never ran, or why it came back an error.
 *
 * Wrapped rather than shortened: this is the sentence the MODEL was handed, and a reason clipped to
 * the width of a path column is a transcript that still cannot say what went wrong.
 */
function Reason(props: { call: ToolCall; inner: number; expand: Expander }): React.ReactNode {
  const width = Math.max(8, props.inner - INDENT.length)
  const rows = wrapWords({ text: reasonOf(props.call), width })
  const shown = shownOf({ body: rows, cap: MAX_ROWS, expand: props.expand })

  return (
    <>
      <JoinedLines
        inner={props.inner}
        groups={[{ fg: theme.error, lines: shown.map((line) => `${INDENT}${line}`) }]}
      />
      <More hidden={rows.length - MAX_ROWS} inner={props.inner} expand={props.expand} />
    </>
  )
}

function FileRead(props: {
  call: ToolCall
  inner: number
  cwd: string
  expand: Expander
}): React.ReactNode {
  const body = detailOf(props.call)
  const lines = useMemo(
    () => codeLinesOf(shownOf({ body: detailOf(props.call), cap: MAX_ROWS, expand: props.expand })),
    [props.call, props.expand.expanded],
  )
  const named = outputOf(props.call).path
  const path = typeof named === 'string' ? named : (targetOf({ call: props.call, cwd: props.cwd }) ?? '')

  return (
    <>
      <CodeLines lines={lines} path={path} inner={props.inner} indent={INDENT} />
      <More hidden={body.length - MAX_ROWS} inner={props.inner} expand={props.expand} />
    </>
  )
}

function Matches(props: { call: ToolCall; inner: number; expand: Expander }): React.ReactNode {
  const found = strings(outputOf(props.call).matches)
  const shown = shownOf({ body: found, cap: MAX_ROWS, expand: props.expand })

  if (shown.length === 0) {
    return <More hidden={found.length - MAX_ROWS} inner={props.inner} expand={props.expand} />
  }

  return (
    <>
      <text wrapMode="none" width={props.inner} flexShrink={0}>
        {shown.map((match, index) => {
          const [path, row, ...rest] = match.split(':')
          return (
            <span key={index}>
              {index === 0 ? '' : '\n'}
              <span fg={theme.meta}>
                {`${INDENT}${tailOfPath({ path: path ?? '', cells: Math.floor(props.inner / PATH_SHARE) })}`}
              </span>
              <span fg={theme.rule}>{`:${row ?? ''}  `}</span>
              <span fg={theme.hint}>{rest.join(':').trim()}</span>
            </span>
          )
        })}
      </text>
      <More hidden={found.length - MAX_ROWS} inner={props.inner} expand={props.expand} />
    </>
  )
}

function Paths(props: {
  call: ToolCall
  inner: number
  cwd: string
  expand: Expander
}): React.ReactNode {
  const found = strings(outputOf(props.call).paths)
  const shown = shownOf({ body: found, cap: MAX_ROWS, expand: props.expand })

  return (
    <>
      <JoinedLines
        inner={props.inner}
        groups={[
          {
            fg: theme.meta,
            lines: shown.map((path) =>
              detailLine({ text: relativise(path, props.cwd), inner: props.inner }),
            ),
          },
        ]}
      />
      <More hidden={found.length - MAX_ROWS} inner={props.inner} expand={props.expand} />
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

function Tests(props: { call: ToolCall; inner: number; expand: Expander }): React.ReactNode {
  const body = detailOf(props.call)
  const tally = body.filter((line) => TALLY.test(line))
  const failures = body.filter((line) => line.startsWith(FAILING)).slice(0, MAX_ROWS)

  if (tally.length === 0) {
    return <Output call={props.call} inner={props.inner} expand={props.expand} />
  }

  return (
    <JoinedLines
      inner={props.inner}
      groups={[
        {
          fg: theme.error,
          lines: failures.map((line) => detailLine({ text: line, inner: props.inner })),
        },
        {
          fg: theme.meta,
          lines: tally.map((line) => detailLine({ text: line.trim(), inner: props.inner })),
        },
      ]}
    />
  )
}

export const DIFF_INSET = 2

function Diff(props: { call: ToolCall; inner: number; cwd: string }): React.ReactNode {
  const file = useMemo(() => {
    const parsed = diffOf(props.call)
    if (parsed === null) return null
    return {
      ...parsed,
      path: relativise(parsed.path, props.cwd),
      hunks: parsed.hunks.map((hunk) => collapseUnchanged({ hunk, context: DIFF_CONTEXT })),
    }
  }, [props.call, props.cwd])
  if (file === null) return null

  return (
    <box marginLeft={DIFF_INSET} marginTop={1}>
      <InlineDiff file={file} width={Math.max(24, props.inner - DIFF_INSET)} />
    </box>
  )
}

export function ToolDetail(props: {
  detail: EDetail
  call: ToolCall
  inner: number
  cwd: string
  expand?: Expander
}): React.ReactNode {
  const expand = props.expand ?? NOT_EXPANDABLE
  if (props.detail === EDetail.None) return null
  if (props.detail === EDetail.Diff) {
    return <Diff call={props.call} inner={props.inner} cwd={props.cwd} />
  }
  if (props.detail === EDetail.Created) {
    return <ToolCreatedFile call={props.call} inner={props.inner} cwd={props.cwd} expand={expand} />
  }
  if (props.detail === EDetail.Reason) {
    return <Reason call={props.call} inner={props.inner} expand={expand} />
  }
  if (props.detail === EDetail.Image) {
    return <ToolImage call={props.call} inner={props.inner} cwd={props.cwd} />
  }
  if (props.detail === EDetail.File) {
    return <FileRead call={props.call} inner={props.inner} cwd={props.cwd} expand={expand} />
  }
  if (props.detail === EDetail.Matches) {
    return <Matches call={props.call} inner={props.inner} expand={expand} />
  }
  if (props.detail === EDetail.Paths) {
    return <Paths call={props.call} inner={props.inner} cwd={props.cwd} expand={expand} />
  }
  if (props.detail === EDetail.Page) {
    return <ToolPage call={props.call} inner={props.inner} expand={expand} />
  }
  if (props.detail === EDetail.Results) {
    return <ToolResults call={props.call} inner={props.inner} expand={expand} />
  }
  if (props.detail === EDetail.Terminal) {
    return <ToolTerminal call={props.call} inner={props.inner} expand={expand} />
  }
  if (props.detail === EDetail.Plan) return <Plan call={props.call} inner={props.inner} />
  if (props.detail === EDetail.Tests) {
    return <Tests call={props.call} inner={props.inner} expand={expand} />
  }
  return <Output call={props.call} inner={props.inner} expand={expand} />
}
