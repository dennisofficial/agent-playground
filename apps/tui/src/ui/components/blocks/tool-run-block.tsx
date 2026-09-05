/**
 * A run of tool calls, drawn: classify, then aggregate, then render.
 *
 * Every call is read once — `classify` — before anything groups it. What comes back decides every
 * question at once: whether the call joins the run's sentence, what prose it gets if it does not, and
 * which renderer it opens into. So a `sed -n '1,60p' file` counts as a READ and a `grep -rn` counts
 * as a SEARCH however they were spelled, while `git push` and `bun test` step out of the sentence
 * entirely and say what they did.
 *
 * Three levels: the sentence, the list of calls under it, and each call's own detail under that. A
 * change skips the first two — a diff behind two clicks is a diff nobody reads — and so does a group
 * of one, which is not a group.
 */

import React from 'react'

import { settled, type ToolCall, type ToolRun } from '../../../store'
import {
  classify,
  EDetail,
  EToolClass,
  measureOfSentence,
  segmentsOf,
  sentenceOf,
  type Read,
  type Segment,
} from '../../../store/tools'
import { useClickRegion } from '../../hooks/use-click-region'
import { useHighWater } from '../../hooks/use-high-water'
import { useShimmerClock } from '../../hooks/use-shimmer-clock'
import { tailOfPath } from '../../paths'
import { spinnerFrame, theme, TRANSCRIPT_INSET } from '../../theme'
import { markPaint, SHIPPED_MARK, type EMark } from '../../tool-marks'
import { ToolDetail } from './tool-detail'
import { moreKey, sentenceKey } from './tool-run-expansion'

const HANG = '  '

const GAP = 2

const STREAM_TAIL = 3

const LANE = 8

const NARROWEST_BAND = 24

/**
 * A row of the list under a sentence.
 *
 * The label takes the BRIGHT colour and the lane and measure either side of it stay at the rule. The
 * list exists to be read down, so the thing being read has to be the thing that is lit; a list where
 * every column is equally dim is a list the eye slides off.
 */
function Row(props: {
  read: Read
  inner: number
  cwd: string
  /** A list of one has nothing to choose between — opening the group IS opening the call. */
  only: boolean
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const { reading, call } = props.read
  const region = useClickRegion(() => props.onToggle(call.callId))
  const lane = (reading.gather ?? '').padEnd(LANE)
  const room = Math.max(4, props.inner - HANG.length - 2 - LANE - reading.note.length - GAP)
  const label = tailOfPath({ path: reading.line, cells: room })
  const pad = ' '.repeat(Math.max(0, room - [...label].length))

  return (
    <box flexDirection="column">
      <text wrapMode="none" width={props.inner} flexShrink={0} {...region.handlers}>
        <span fg={theme.rule} {...region.wash}>{`${HANG}  ${lane}`}</span>
        <span fg={reading.failed ? theme.error : theme.hover} {...region.wash}>
          {`${label}${pad}`}
        </span>
        <span fg={theme.rule} {...region.wash}>{`${' '.repeat(GAP)}${reading.note}`}</span>
      </text>
      {props.only || props.opened.has(call.callId) ? (
        <ToolDetail
          detail={reading.detail}
          call={call}
          inner={props.inner}
          cwd={props.cwd}
          expand={{
            expanded: props.opened.has(moreKey(call.callId)),
            onToggle: () => props.onToggle(moreKey(call.callId)),
          }}
        />
      ) : null}
    </box>
  )
}

/**
 * The last few lines a call in flight has printed.
 *
 * No `⎿` on these. It would be drawn once per line, so a three-line window puts three of them down
 * the left edge — and a blank line of output renders as a lone glyph with nothing after it. The rows
 * are already dim and already indented; the glyph says a third time what those two say.
 */
function Streaming(props: { call: ToolCall; inner: number }): React.ReactNode {
  const shown = detailTail(props.call)
  const reserved = useHighWater({ rows: shown.length, live: true })

  return (
    <>
      {Array.from({ length: reserved }, (_unused, index) => shown[index]).map((line, index) => (
        <text key={index} wrapMode="none" width={props.inner} flexShrink={0}>
          <span fg={index === shown.length - 1 ? theme.hint : theme.rule}>
            {line === undefined
              ? ' '
              : `${HANG}${tailOfPath({ path: line, cells: Math.max(8, props.inner - HANG.length) })}`}
          </span>
        </text>
      ))}
    </>
  )
}

const detailTail = (call: ToolCall): readonly string[] =>
  call.modelText.length === 0 ? [] : call.modelText.split('\n').slice(-STREAM_TAIL)

function SentenceBlock(props: {
  reads: readonly Read[]
  inner: number
  cwd: string
  now: number
  mark: EMark
  opensCluster: boolean
  blockKey: string
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const running = props.reads.find((read) => !settled(read.call))
  const done = props.reads.filter((read) => settled(read.call))
  const open = props.opened.has(props.blockKey)
  const region = useClickRegion(
    running === undefined && done.length > 0 ? () => props.onToggle(props.blockKey) : undefined,
  )
  const paint = markPaint({
    style: props.mark,
    klass: EToolClass.Gathered,
    ok: true,
    opensCluster: props.opensCluster,
    ...(running === undefined ? {} : { spinner: spinnerFrame(props.now) }),
  })

  return (
    <box flexDirection="column" marginBottom={1} width={props.inner} flexShrink={0}>
      <text wrapMode="none" width={props.inner} flexShrink={0} {...region.handlers}>
        <span fg={paint.fg} {...region.wash}>
          {paint.glyph}
        </span>
        <span fg={paint.text} {...region.wash}>
          {done.length === 0 ? 'Working…' : sentenceOf(done)}
        </span>
        <span fg={theme.rule} {...region.wash}>
          {measureOfSentence(done)}
        </span>
      </text>

      {running === undefined ? null : <Streaming call={running.call} inner={props.inner} />}

      {running === undefined && open
        ? done.map((read) => (
            <Row
              key={read.call.callId}
              read={read}
              inner={props.inner}
              cwd={props.cwd}
              only={done.length === 1}
              opened={props.opened}
              onToggle={props.onToggle}
            />
          ))
        : null}
    </box>
  )
}

function AloneBlock(props: {
  read: Read
  repeats: number
  inner: number
  cwd: string
  now: number
  mark: EMark
  opensCluster: boolean
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const { call, reading } = props.read
  const region = useClickRegion(() => props.onToggle(call.callId))
  const running = !settled(call)
  const standing = reading.alone ?? reading.line
  const said = props.repeats > 1 ? `${standing} × ${props.repeats}` : standing
  const paint = markPaint({
    style: props.mark,
    klass: reading.klass,
    ok: !reading.failed,
    opensCluster: props.opensCluster,
    ...(running ? { spinner: spinnerFrame(props.now) } : {}),
  })
  const room = Math.max(8, props.inner - 2 - reading.note.length - GAP)
  const label = tailOfPath({ path: said, cells: room })
  const pad = ' '.repeat(Math.max(0, room - [...label].length))
  /**
   * A change shows what it changed and a picture shows itself. Output stays behind the row whether
   * or not the call succeeded, and so does the reason a call failed: a failure is already said by
   * the mark, the colour and the note, and a wall of stderr unfolded unasked buries the rest of the
   * transcript.
   */
  const shows =
    reading.detail === EDetail.Diff ||
    reading.detail === EDetail.Created ||
    reading.detail === EDetail.Image ||
    reading.detail === EDetail.Terminal ||
    props.opened.has(call.callId)
  /**
   * A call still being dictated shows what it is dictating, not the streaming tail: the content is
   * on the call, so the panel it will settle into can be drawn now rather than after the last
   * argument lands.
   */
  const dictating =
    running &&
    (reading.detail === EDetail.Created || reading.detail === EDetail.Terminal)

  return (
    <box flexDirection="column" marginBottom={1} width={props.inner} flexShrink={0}>
      <text wrapMode="none" width={props.inner} flexShrink={0} {...region.handlers}>
        <span fg={paint.fg} {...region.wash}>
          {paint.glyph}
        </span>
        <span fg={paint.text} {...region.wash}>{`${label}${pad}`}</span>
        <span fg={paint.note} {...region.wash}>{`${' '.repeat(GAP)}${reading.note}`}</span>
      </text>
      {running && !dictating ? <Streaming call={call} inner={props.inner} /> : null}
      {dictating || (!running && shows) ? (
        <ToolDetail
          detail={reading.detail}
          call={call}
          inner={props.inner}
          cwd={props.cwd}
          expand={{
            expanded: props.opened.has(moreKey(call.callId)),
            onToggle: () => props.onToggle(moreKey(call.callId)),
          }}
        />
      ) : null}
    </box>
  )
}

/**
 * What a segment costs, in rows — an ESTIMATE, and deliberately a crude one.
 *
 * It ignores diffs and opened detail entirely, which are tall. That is fine: the ratchet compares
 * this number against itself over time, so a formula that is consistently wrong reserves exactly as
 * much as a formula that is right. What it must get correct is the DIRECTION of every change.
 */
const rowsOf = (segment: Segment, opened: ReadonlySet<string>): number => {
  if (segment.kind === 'alone') return settled(segment.read.call) ? 2 : 2 + STREAM_TAIL
  if (segment.reads.some((read) => !settled(read.call))) return 2 + STREAM_TAIL
  return 2 + (opened.has(sentenceKey(segment.key)) ? segment.reads.length : 0)
}

export function ToolRunBlock(props: {
  run: ToolRun
  width: number
  cwd: string
  now?: number
  mark?: EMark
  /**
   * Whether the entry above this one was also a tool run. When it was, this block continues a cluster
   * rather than opening one, and its first row keeps its glyph to itself.
   */
  continues?: boolean
  opened?: ReadonlySet<string>
  onToggle?: (key: string) => void
}): React.ReactNode {
  const live = props.run.calls.some((call) => !settled(call))
  const clock = useShimmerClock({ active: live && props.now === undefined })
  const now = props.now ?? clock
  const opened = props.opened ?? NOTHING_OPEN
  const onToggle = props.onToggle ?? ignore
  const inner = Math.max(NARROWEST_BAND, props.width - TRANSCRIPT_INSET)
  const segments = segmentsOf({ calls: props.run.calls, cwd: props.cwd })
  const rows = segments.reduce((total, segment) => total + rowsOf(segment, opened), 0)
  const reserved = useHighWater({ rows, live })
  const mark = props.mark ?? SHIPPED_MARK

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'sentence' ? (
          <SentenceBlock
            key={segment.key}
            reads={segment.reads}
            inner={inner}
            cwd={props.cwd}
            now={now}
            mark={mark}
            opensCluster={index === 0 && props.continues !== true}
            blockKey={sentenceKey(segment.key)}
            opened={opened}
            onToggle={onToggle}
          />
        ) : (
          <AloneBlock
            key={segment.key}
            read={segment.read}
            repeats={segment.repeats}
            inner={inner}
            cwd={props.cwd}
            now={now}
            mark={mark}
            opensCluster={index === 0 && props.continues !== true}
            opened={opened}
            onToggle={onToggle}
          />
        ),
      )}
      {Array.from({ length: Math.max(0, reserved - rows) }, (_unused, index) => (
        <text key={`hold${index}`}> </text>
      ))}
    </>
  )
}

const NOTHING_OPEN: ReadonlySet<string> = new Set()

const ignore = (): void => undefined
