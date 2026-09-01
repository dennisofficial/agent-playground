import type { ThreadId } from '../../events/ids'
import type { EToolEffect } from '../../tools/tool'
import type { CommandReading } from './command/read-command'
import type { Deed, EDeed } from './deed'
import type { WorkspaceFacts } from './facts'
import type { Grant } from './grant'

export type RecentAct = {
  name: string
  effect: EToolEffect
  deeds: readonly EDeed[]
  ingestedUntrustedContent: boolean
  readSecretShapedPath: boolean
}

export type OperatorUtterance = { text: string; seq: number }

export type CallEvidence = {
  deeds: readonly Deed[]
  toolName: string
  effect: EToolEffect
  threadId: ThreadId
  reading: CommandReading | undefined
  facts: WorkspaceFacts
  recent: readonly RecentAct[]
  said: readonly OperatorUtterance[]
  grants: readonly Grant[]
}
