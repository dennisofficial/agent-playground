import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ScrollBoxRenderable } from '@opentui/core'

import { EEntryKind, type PendingRow, type TranscriptModel } from '../../store'
import { NOTHING_IN_BACKGROUND, type BackgroundWork } from '../background-wait'
import { useEntryWindow } from '../hooks/use-entry-window'
import { useTranscriptFollow } from '../hooks/use-transcript-follow'
import { useHiddenVerticalScrollbar } from '../hide-scrollbar'
import { TRANSCRIPT_PADDING } from '../theme'
import { useTranscriptViewport } from '../transcript-viewport-store'
import { applyTranscriptBounds } from '../viewport-rows-store'
import { ErrorBlock } from './blocks/error-block'
import { PendingBlock } from './blocks/pending-block'
import { ResumeBlock } from './blocks/resume-block'
import { openedSubsetOf, type OpenedSubsets } from './blocks/tool-run-expansion'
import { EntryView } from './entry-view'
import { JumpToBottom, NewDivider, UNSEEN_ANCHOR_ID } from './new-divider'
import { PeekLine } from './peek-line'
import type { RetryWait } from '../retry-countdown'
import { EWorkingVerb, WaitingLine, WorkingLine } from './working-line'

export type { RetryWait }

export type TurnClock = {
  startedAt: number | null
  outputTokens: number
  interrupting: boolean
  reasoning: boolean
  completed: { durationMs: number; outputTokens: number } | null
  retry: RetryWait | null
}

export const IDLE_TURN: TurnClock = {
  startedAt: null,
  outputTokens: 0,
  interrupting: false,
  reasoning: false,
  completed: null,
  retry: null,
}

const FAILURE_WITHOUT_A_REASON = 'The model reported no reason.'

const NOTHING_PENDING: readonly PendingRow[] = Object.freeze([])

export function Transcript(props: {
  model: TranscriptModel
  width: number
  now: number
  cwd: string
  turn?: TurnClock
  anchorKey?: string | null
  sends?: number
  pending?: readonly PendingRow[]
  background?: BackgroundWork
  /** When the wait on that background work began, held above this mount. See `WaitingLine`. */
  waitingSince?: number | null
  onRetry?: () => void
  onResume?: () => void
  opened?: ReadonlySet<string>
  onToggle?: (key: string) => void
}): React.ReactNode {
  const { model } = props
  const turn = props.turn ?? IDLE_TURN
  const anchorKey = props.anchorKey ?? null
  const anchorIndex = model.entries.findIndex((entry) => entry.key === anchorKey)
  const peekKeys = useMemo(
    () =>
      new Set(
        model.entries
          .filter((entry) => entry.kind === EEntryKind.OperatorSaid)
          .map((entry) => entry.key),
      ),
    [model.entries],
  )
  const scroller = useRef<ScrollBoxRenderable | null>(null)
  const windowing = useEntryWindow({
    entries: model.entries,
    scroller,
    anchorIndex,
    width: props.width,
  })
  const follow = useTranscriptFollow({
    scroller,
    anchorId: anchorIndex >= 0 ? UNSEEN_ANCHOR_ID : null,
    sends: props.sends ?? 0,
    peekKeys,
    onTick: windowing.handleTick,
    offsetOfKey: windowing.offsetOfKey,
  })
  const handleScroller = useHiddenVerticalScrollbar(follow.scroller)

  useEffect(() => {
    const box = follow.scroller.current?.viewport
    applyTranscriptBounds({ top: box?.y ?? 0, rows: box?.height ?? 0 })
  })
  const viewport = useTranscriptViewport()
  const peeked = model.entries.find((entry) => entry.key === viewport.peekKey) ?? null

  const [ownOpened, setOwnOpened] = useState<ReadonlySet<string>>(() => new Set<string>())
  const handleOwnToggle = useCallback((key: string) => {
    setOwnOpened((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const opened = props.opened ?? ownOpened
  const handleToggle = props.onToggle ?? handleOwnToggle
  const openedSubsets = useMemo((): OpenedSubsets => new WeakMap(), [])

  const peekLine =
    viewport.tailing || peeked === null ? null : (
      <PeekLine
        text={peeked.text}
        width={props.width}
        onJumpTo={() => follow.handleJumpTo(peeked.key)}
      />
    )

  const mounted: React.ReactNode[] = []
  windowing.sections.forEach((section, sectionIndex) => {
    if (section.kind === 'spacer') {
      mounted.push(<box key={`spacer:${sectionIndex}`} height={section.height} flexShrink={0} />)
      return
    }
    for (let index = section.span.start; index < section.span.end; index += 1) {
      const entry = model.entries[index]
      if (entry === undefined) continue
      mounted.push(
        <box key={entry.key} id={entry.key} flexDirection="column">
          {index === anchorIndex ? (
            <box id={UNSEEN_ANCHOR_ID} flexDirection="column">
              {index > 0 ? <NewDivider width={props.width} /> : null}
            </box>
          ) : null}
          <EntryView
            entry={entry}
            width={props.width}
            expanded={opened.has(entry.key)}
            {...(entry.kind === EEntryKind.ToolsRan
              ? { opened: openedSubsetOf({ cache: openedSubsets, run: entry.run, opened }) }
              : {})}
            onToggle={handleToggle}
            cwd={props.cwd}
            continues={model.entries[index - 1]?.kind === EEntryKind.ToolsRan}
          />
        </box>,
      )
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      {peekLine}
      <scrollbox
        ref={handleScroller}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        focusable={false}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        contentOptions={{ paddingRight: TRANSCRIPT_PADDING }}
      >
        {mounted}

        {model.failure ? (
          <ErrorBlock
            message={model.failure.message ?? FAILURE_WITHOUT_A_REASON}
            width={props.width}
            {...(turn.completed === null
              ? {}
              : {
                  durationMs: turn.completed.durationMs,
                  outputTokens: turn.completed.outputTokens,
                })}
            {...(props.onRetry === undefined ? {} : { onRetry: props.onRetry })}
          />
        ) : null}

        {model.failure !== null || model.streaming || props.onResume === undefined ? null : (
          <ResumeBlock onResume={props.onResume} />
        )}

        {model.failure === null && model.streaming && turn.startedAt !== null ? (
          <box flexDirection="row" marginTop={1} marginBottom={1}>
            <WorkingLine
              elapsedMs={props.now - turn.startedAt}
              outputTokens={turn.outputTokens}
              interrupting={turn.interrupting}
              verb={turn.reasoning ? EWorkingVerb.Thinking : EWorkingVerb.Working}
              retry={turn.retry}
            />
          </box>
        ) : (
          <WaitingLine
            work={props.background ?? NOTHING_IN_BACKGROUND}
            since={props.waitingSince ?? null}
          />
        )}

        <PendingBlock rows={props.pending ?? NOTHING_PENDING} width={props.width} />
      </scrollbox>

      {viewport.tailing ? null : (
        <JumpToBottom width={props.width} onJump={follow.handleJumpToBottom} />
      )}
    </box>
  )
}
