import React from 'react'

import { EEntryKind, type TranscriptEntry } from '../../store'
import { AssistantBlock } from './blocks/assistant-block'
import { ThinkingBlock } from './blocks/thinking-block'
import { UserBlock } from './blocks/user-block'

export function EntryView(props: {
  entry: TranscriptEntry
  width: number
  expanded?: boolean
  onToggle?: (key: string) => void
}): React.ReactNode {
  const { entry, onToggle } = props

  switch (entry.kind) {
    case EEntryKind.OperatorSaid:
      return <UserBlock text={entry.text} width={props.width} />

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
          interrupted={entry.interrupted}
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
