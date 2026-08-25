import React, { useCallback, useState } from 'react'

import type { TranscriptModel } from '../../store'
import { useTranscriptFollow } from '../hooks/use-transcript-follow'
import { useProportionalThumb } from '../scrollbar-thumb'
import { theme, TRANSCRIPT_PADDING } from '../theme'
import { ErrorBlock } from './blocks/error-block'
import { EntryView } from './entry-view'
import { JumpToBottom, NewDivider, UNSEEN_ANCHOR_ID } from './new-divider'
import { WorkingLine } from './working-line'

export type TurnClock = {
  startedAt: number | null
  outputTokens: number
  interrupting: boolean
  completed: { durationMs: number; outputTokens: number } | null
}

export const IDLE_TURN: TurnClock = {
  startedAt: null,
  outputTokens: 0,
  interrupting: false,
  completed: null,
}

const FAILURE_TITLE = 'The turn failed'

const FAILURE_WITHOUT_A_REASON = 'The model reported no reason.'

const EMPTY_HINT = 'Describe the work.'

export function Transcript(props: {
  model: TranscriptModel
  width: number
  now: number
  cwd: string
  turn?: TurnClock
  anchorKey?: string | null
}): React.ReactNode {
  const { model } = props
  const turn = props.turn ?? IDLE_TURN
  const anchorKey = props.anchorKey ?? null
  const anchorIndex = model.entries.findIndex((entry) => entry.key === anchorKey)
  const follow = useTranscriptFollow({ anchorId: anchorIndex >= 0 ? UNSEEN_ANCHOR_ID : null })
  const handleScroller = useProportionalThumb(follow.scroller)

  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>())
  const handleToggle = useCallback((key: string) => {
    setOpened((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
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
        {model.entries.map((entry, index) => (
          <box
            key={entry.key}
            flexDirection="column"
            {...(index === anchorIndex ? { id: UNSEEN_ANCHOR_ID } : {})}
          >
            {index === anchorIndex && index > 0 ? <NewDivider width={props.width} /> : null}
            <EntryView
              entry={entry}
              width={props.width}
              expanded={opened.has(entry.key)}
              onToggle={handleToggle}
            />
          </box>
        ))}

        {model.isEmpty && !model.streaming ? (
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.dim}>{props.cwd}</text>
            <text> </text>
            <text fg={theme.dim}>{EMPTY_HINT}</text>
          </box>
        ) : null}

        {model.failure ? (
          <ErrorBlock
            title={FAILURE_TITLE}
            detail={model.failure.message ?? FAILURE_WITHOUT_A_REASON}
          />
        ) : null}

        {model.streaming && turn.startedAt !== null ? (
          <box flexDirection="row" marginTop={1} marginBottom={1}>
            <WorkingLine
              running
              elapsedMs={props.now - turn.startedAt}
              outputTokens={turn.outputTokens}
              interrupting={turn.interrupting}
            />
          </box>
        ) : turn.completed ? (
          <box flexDirection="row" marginTop={1} marginBottom={1}>
            <WorkingLine
              running={false}
              elapsedMs={turn.completed.durationMs}
              outputTokens={turn.completed.outputTokens}
              interrupting={false}
            />
          </box>
        ) : null}
      </scrollbox>

      {follow.pinned ? null : (
        <JumpToBottom width={props.width} onJump={follow.handleJumpToBottom} />
      )}
    </box>
  )
}
