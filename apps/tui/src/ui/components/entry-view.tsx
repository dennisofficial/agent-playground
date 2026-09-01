import React from 'react'

import { EEntryKind, type TranscriptEntry } from '../../store'
import type { EMark } from '../tool-marks'
import { AssistantBlock } from './blocks/assistant-block'
import { CompactedBlock } from './blocks/compacted-block'
import { NoticeBlock } from './blocks/notice-block'
import { ThinkingBlock } from './blocks/thinking-block'
import { ToolRunBlock } from './blocks/tool-run-block'
import { TurnEndedBlock } from './blocks/turn-ended-block'
import { EUserMark, UserBlock } from './blocks/user-block'

const SHELL_OUTPUT_HINT = '↵ output'

const PRINTED_NOTHING = 'printed nothing'

const MATCHED_LINES_HINT = '↵ matches'

const MATCHED_NOTHING = 'matched nothing'

const AGENT_REPORT_HINT = '↵ report'

const REPORTED_NOTHING = 'reported nothing'

export function EntryView(props: {
  entry: TranscriptEntry
  width: number
  expanded?: boolean
  onToggle?: (key: string) => void
  /**
   * Where the session is standing, so a tool row can say `src/ui/theme.ts` rather than the absolute
   * path the tool was actually handed.
   */
  cwd?: string
  /** The transcript's whole expansion set — a tool run owns three levels of it, not one flag. */
  opened?: ReadonlySet<string>
  /** Whether the entry above was also a tool run, so this one continues a cluster rather than opening one. */
  continues?: boolean
  /** How loudly a tool row's gutter should speak. Defaults to the shipped style. */
  mark?: EMark
}): React.ReactNode {
  const { entry, onToggle } = props

  switch (entry.kind) {
    case EEntryKind.OperatorSaid:
      return (
        <UserBlock
          said={entry.said}
          width={props.width}
          mark={entry.steer ? EUserMark.MidTurn : EUserMark.Plain}
          skills={entry.skills}
          files={entry.files}
        images={entry.images}
        />
      )

    case EEntryKind.ModelSaid:
      return (
        <AssistantBlock
          text={entry.text}
          width={props.width}
          streaming={entry.streaming}
          interrupted={entry.interrupted}
        />
      )

    case EEntryKind.ModelThought:
      return (
        <ThinkingBlock
          text={entry.text}
          width={props.width}
          streaming={entry.streaming}
          heldOpen={entry.heldOpen}
          interrupted={entry.interrupted}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.ToolsRan:
      return (
        <ToolRunBlock
          run={entry.run}
          width={props.width}
          cwd={props.cwd ?? ''}
          {...(props.continues === undefined ? {} : { continues: props.continues })}
          {...(props.mark === undefined ? {} : { mark: props.mark })}
          {...(props.opened === undefined ? {} : { opened: props.opened })}
          {...(onToggle ? { onToggle } : {})}
        />
      )

    case EEntryKind.HistoryCompacted:
      return (
        <CompactedBlock
          text={entry.text}
          width={props.width}
          compactedEntries={entry.compactedEntries}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.BackgroundShellAwaitingInput:
      return (
        <NoticeBlock
          text={entry.text}
          body={entry.output}
          failed
          width={props.width}
          openHint={SHELL_OUTPUT_HINT}
          silentNote={PRINTED_NOTHING}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.BackgroundShellMatched:
      return (
        <NoticeBlock
          text={entry.text}
          body={entry.output}
          failed={false}
          width={props.width}
          openHint={MATCHED_LINES_HINT}
          silentNote={MATCHED_NOTHING}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.BackgroundShellEnded:
      return (
        <NoticeBlock
          text={entry.text}
          body={entry.output}
          failed={entry.failed}
          width={props.width}
          openHint={SHELL_OUTPUT_HINT}
          silentNote={PRINTED_NOTHING}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.AgentEnded:
      return (
        <NoticeBlock
          text={entry.text}
          body={entry.report}
          failed={entry.failed}
          width={props.width}
          openHint={AGENT_REPORT_HINT}
          silentNote={REPORTED_NOTHING}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.TurnEnded:
      return (
        <TurnEndedBlock
          durationMs={entry.durationMs}
          outputTokens={entry.outputTokens}
          endedAt={entry.endedAt}
          interrupted={entry.interrupted}
        />
      )

    default: {
      const unrendered: never = entry
      return unrendered
    }
  }
}
