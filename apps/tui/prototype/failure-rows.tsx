// PROTOTYPE — throwaway. Should a failure LEAVE the sentence?
//
// Two rules under test, against real threads out of the sqlite store:
//
//   pull-out  A failed call stops joining the run's sentence and becomes its own row, in place —
//             the way a Change and a named Command already break it. The sentence then never has a
//             failure to represent, so `· N failed` and the whole-line red both stop existing.
//
//   exit fix  A multi-stage shell line's exit code belongs to its LAST stage, while `readShell`
//             classifies the clause from the EARLIEST recognised one. So `grep … | head; ls; cat x`
//             is read as a search, prints its matches, and is called failed because `cat` returned 1.
//             Under the fix a gathered clause only trusts the exit code when one stage remains
//             after `withoutCd`. Named commands keep trusting it — that is what they are for.
//
// Across 30 real threads, 27 of 1,769 calls were gathered-and-failed. The exit fix leaves 7, and the
// 20 it clears are all commands that worked — a trailing `cat`, `ls` or `| head` returning 1. Without
// it, pull-out would have turned those 20 false alarms into 20 dedicated red rows.
//
//   bun prototype/failure-rows.tsx
//   bun prototype/failure-rows.tsx --list
//   bun prototype/failure-rows.tsx --thread=brn_…
//   bun prototype/failure-rows.tsx --db=/path.db
//
// It must own a real terminal: `bun run --filter` and `turbo run` both pipe a script's output.
//
// t · today / proposed / both    x · exit fix    s · synthetic or real    q · quit

import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react'
import React, { useMemo, useState } from 'react'

import { toolRuns, type ToolCall } from '../src/store'
import {
  classify,
  EToolClass,
  inputOf,
  measureOfSentence,
  outputOf,
  sentenceOf,
  str,
  type Classification,
  type Read,
} from '../src/store/tools'
import { CWD } from '../src/store/tools/__tests__/fixture'
import { theme } from '../src/ui/theme'
import { SYNTHETIC, type Case } from './failure/cases'
import { rowsOf } from './failure/rules'
import { databasePath, loadThread, threadsIn } from './tools/load'

const lastMeaningful = (text: string): string => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1) ?? ''
}

const reasonOfCall = (call: ToolCall): string => {
  if (call.note !== null && call.note.length > 0) return call.note
  const stdout = str(outputOf(call).stdout) ?? ''
  return lastMeaningful(stdout)
}

const CAP = 96

const clip = (text: string, cells: number): string =>
  [...text].length <= cells ? text : `${[...text].slice(0, cells - 1).join('')}…`

function SentenceRow(props: { reads: readonly Read[]; width: number }): React.ReactNode {
  const failed = props.reads.some((read) => read.reading.failed)

  return (
    <text wrapMode="none" width={props.width} flexShrink={0}>
      <span fg={failed ? theme.error : theme.rule}>{'⏺ '}</span>
      <span fg={failed ? theme.error : theme.meta}>{sentenceOf(props.reads)}</span>
      <span fg={theme.rule}>{measureOfSentence(props.reads)}</span>
    </text>
  )
}

function AloneRow(props: { read: Read; width: number; showReason: boolean }): React.ReactNode {
  const { reading, call } = props.read
  const label = reading.alone ?? reading.line
  const reason = props.showReason && reading.failed ? reasonOfCall(call) : ''

  return (
    <box flexDirection="column">
      <text wrapMode="none" width={props.width} flexShrink={0}>
        <span fg={reading.failed ? theme.error : theme.rule}>{'⏺ '}</span>
        <span fg={reading.failed ? theme.error : theme.meta}>{clip(label, CAP)}</span>
        <span fg={theme.rule}>{reading.note.length === 0 ? '' : `  ${reading.note}`}</span>
      </text>
      {reason === '' ? null : (
        <text wrapMode="none" width={props.width} flexShrink={0}>
          <span fg={theme.rule}>{'  ⎿ '}</span>
          <span fg={theme.error}>{clip(reason, CAP)}</span>
        </text>
      )}
    </box>
  )
}

function Rows(props: {
  calls: readonly ToolCall[]
  pullOut: boolean
  exitFix: boolean
  width: number
}): React.ReactNode {
  const rows = rowsOf({ calls: props.calls, pullOut: props.pullOut, exitFix: props.exitFix })

  return (
    <box flexDirection="column">
      {rows.map((row) =>
        row.kind === 'sentence' ? (
          <SentenceRow key={row.key} reads={row.reads} width={props.width} />
        ) : (
          <AloneRow key={row.key} read={row.read} width={props.width} showReason={props.pullOut} />
        ),
      )}
    </box>
  )
}

enum EShow {
  Today = 'today',
  Proposed = 'proposed',
  Both = 'both',
}

const SHOW_ORDER: readonly EShow[] = [EShow.Both, EShow.Today, EShow.Proposed]

function Case(props: {
  name: string
  calls: readonly ToolCall[]
  show: EShow
  exitFix: boolean
  width: number
}): React.ReactNode {
  return (
    <box flexDirection="column" marginBottom={1}>
      <text wrapMode="none">
        <span fg={theme.hover}>{props.name}</span>
      </text>
      {props.show !== EShow.Proposed ? (
        <box flexDirection="column" marginTop={1}>
          <text wrapMode="none">
            <span fg={theme.rule}>{'  today'}</span>
          </text>
          <Rows calls={props.calls} pullOut={false} exitFix={false} width={props.width} />
        </box>
      ) : null}
      {props.show !== EShow.Today ? (
        <box flexDirection="column" marginTop={1}>
          <text wrapMode="none">
            <span fg={theme.rule}>
              {`  proposed — pull-out${props.exitFix ? ' + exit fix' : ', exit fix OFF'}`}
            </span>
          </text>
          <Rows calls={props.calls} pullOut exitFix={props.exitFix} width={props.width} />
        </box>
      ) : null}
    </box>
  )
}

function Prototype(props: { real: readonly Case[]; title: string }): React.ReactNode {
  const { width } = useTerminalDimensions()
  const [showIndex, setShowIndex] = useState(0)
  const [exitFix, setExitFix] = useState(true)
  const [synthetic, setSynthetic] = useState(true)

  useKeyboard((key) => {
    if (key.eventType === 'release') return
    if (key.name === 't') setShowIndex((current) => current + 1)
    if (key.name === 'x') setExitFix((current) => !current)
    if (key.name === 's') setSynthetic((current) => !current)
    if (key.name === 'q') process.exit(0)
  })

  const show = SHOW_ORDER[showIndex % SHOW_ORDER.length] ?? EShow.Both
  const cases = synthetic ? SYNTHETIC : props.real
  const inner = Math.max(40, width - 6)

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <box
        flexDirection="row"
        flexShrink={0}
        backgroundColor={theme.panelBg}
        paddingLeft={2}
        paddingRight={2}
      >
        <text fg={theme.hover}>{synthetic ? 'synthetic cases' : props.title}</text>
        <box flexGrow={1} />
        <text fg={theme.meta}>
          {`t · ${show}    x · exit fix ${exitFix ? 'on' : 'off'}    s · ${synthetic ? 'real thread' : 'synthetic'}    q · quit`}
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        focusable
        contentOptions={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1 }}
      >
        {cases.map((entry) => (
          <Case
            key={entry.name}
            name={entry.name}
            calls={entry.calls}
            show={show}
            exitFix={exitFix}
            width={inner}
          />
        ))}
      </scrollbox>
    </box>
  )
}

const PIPED = 1

const argOf = (argv: readonly string[], flag: string): string | undefined =>
  argv.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3)

/** Only the runs that actually contain a failure — the rest have nothing to say about this. */
function interestingRuns(calls: readonly (readonly ToolCall[])[]): Case[] {
  return calls
    .filter((group) => group.some((call) => classify({ call, cwd: CWD }).failed))
    .map((group, index) => ({ name: `real run ${index + 1} — ${group.length} calls`, calls: group }))
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const path = databasePath(argv)

  if (argv.includes('--list')) {
    for (const row of threadsIn(path)) {
      process.stdout.write(
        `${row.id}  ${String(row.tools).padStart(4)} calls  ${row.title ?? '(untitled)'}\n`,
      )
    }
    process.exit(0)
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      'This prototype needs a real terminal. Run `bun prototype/failure-rows.tsx` from apps/tui — ' +
        'not through `bun run --filter` or `turbo run`, which pipe the output.\n',
    )
    process.exit(PIPED)
  }

  const threadId = argOf(argv, 'thread')
  const thread = loadThread({ path, ...(threadId === undefined ? {} : { threadId }) })
  const real = interestingRuns(toolRuns(thread.events).map((run) => run.calls))

  const renderer = await createCliRenderer({ useMouse: true, exitOnCtrlC: true, targetFps: 60 })
  renderer.on('destroy', () => process.exit(0))

  createRoot(renderer).render(
    <Prototype real={real} title={`${thread.thread.title ?? '(untitled)'} — runs containing a failure`} />,
  )
}
