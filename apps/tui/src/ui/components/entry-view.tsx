import React from 'react'

import { EEntryKind, type TranscriptEntry } from '../../store'
import { AssistantBlock } from './blocks/assistant-block'
import { CompactedBlock } from './blocks/compacted-block'
import { ShellEndedBlock } from './blocks/shell-ended-block'
import { ThinkingBlock } from './blocks/thinking-block'
import { ToolGroupBlock } from './blocks/tool-group-block'
import { EUserMark, UserBlock } from './blocks/user-block'

export function EntryView(props: {
  entry: TranscriptEntry
  width: number
  expanded?: boolean
  onToggle?: (key: string) => void
  attached?: boolean
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
        />
      )

    case EEntryKind.ModelSaid:
      return (
        <AssistantBlock
          text={entry.text}
          width={props.width}
          streaming={entry.streaming}
          interrupted={entry.interrupted}
          {...(props.attached === undefined ? {} : { attached: props.attached })}
        />
      )

    case EEntryKind.ModelThought:
      return (
        <ThinkingBlock
          text={entry.text}
          width={props.width}
          streaming={entry.streaming}
          interrupted={entry.interrupted}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.ToolsRan:
      return (
        <ToolGroupBlock
          group={entry.group}
          width={props.width}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    case EEntryKind.HistoryCompacted:
      return (
        <CompactedBlock
          text={entry.text}
          width={props.width}
          compactedEntries={entry.compactedEntries}
        />
      )

    case EEntryKind.BackgroundShellEnded:
      return (
        <ShellEndedBlock
          text={entry.text}
          output={entry.output}
          failed={entry.failed}
          width={props.width}
          expanded={props.expanded ?? false}
          {...(onToggle ? { onToggle: () => onToggle(entry.key) } : {})}
        />
      )

    default: {
      const unrendered: never = entry
      return unrendered
    }
  }
}
