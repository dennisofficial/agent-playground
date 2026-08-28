import React, { useCallback, useState } from 'react'

import { EEntryKind, type PendingRow, type TranscriptModel } from '../../store'
import { useTranscriptFollow } from '../hooks/use-transcript-follow'
import { useHiddenVerticalScrollbar } from '../hide-scrollbar'
import { TRANSCRIPT_PADDING } from '../theme'
import { ErrorBlock } from './blocks/error-block'
import { PendingBlock } from './blocks/pending-block'
import { WelcomeBlock } from './blocks/welcome-block'
import { EntryView } from './entry-view'
import { JumpToBottom, NewDivider, UNSEEN_ANCHOR_ID } from './new-divider'
import { EWorkingVerb, WorkingLine } from './working-line'

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

const FAILURE_WITHOUT_A_REASON = 'The model reported no reason.'

const NOTHING_PENDING: readonly PendingRow[] = Object.freeze([])

export type Compacting = { startedAt: number; cancelling: boolean }

export function Transcript(props: {
  model: TranscriptModel
  width: number
  now: number
  cwd: string
  home: string
  modelId: string
  turn?: TurnClock
  anchorKey?: string | null
  sends?: number
  pending?: readonly PendingRow[]
  compacting?: Compacting | undefined
  onRetry?: () => void
  opened?: ReadonlySet<string>
  onToggle?: (key: string) => void
}): React.ReactNode {
  const { model } = props
  const turn = props.turn ?? IDLE_TURN
  const anchorKey = props.anchorKey ?? null
  const anchorIndex = model.entries.findIndex((entry) => entry.key === anchorKey)
  const follow = useTranscriptFollow({
    anchorId: anchorIndex >= 0 ? UNSEEN_ANCHOR_ID : null,
    sends: props.sends ?? 0,
  })
  const handleScroller = useHiddenVerticalScrollbar(follow.scroller)

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
              attached={model.entries[index + 1]?.kind === EEntryKind.ToolsRan}
            />
          </box>
        ))}

        {model.isEmpty && !model.streaming ? (
          <WelcomeBlock
            cwd={props.cwd}
            home={props.home}
            modelId={props.modelId}
            width={props.width}
          />
        ) : null}

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

        {props.compacting === undefined ? null : (
          <box flexDirection="row" marginTop={1} marginBottom={1}>
            <WorkingLine
              running
              elapsedMs={Math.max(0, props.now - props.compacting.startedAt)}
              outputTokens={0}
              interrupting={props.compacting.cancelling}
              verb={EWorkingVerb.Compacting}
            />
          </box>
        )}

        {model.failure !== null ? null : model.streaming && turn.startedAt !== null ? (
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

        <PendingBlock rows={props.pending ?? NOTHING_PENDING} width={props.width} />
      </scrollbox>

      {follow.pinned ? null : (
        <JumpToBottom width={props.width} onJump={follow.handleJumpToBottom} />
      )}
    </box>
  )
}
