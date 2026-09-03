import { EAgentStatus } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'
import React from 'react'

import type { EThinkingVisibility } from '../store'
import { Transcript } from '../ui/components/transcript'
import type { AtlasApp } from './compose'
import { transcriptOfTurn, turnOfChild } from './turn-progress'
import { useTickingNow } from './use-ticking-now'
import { EThreadRows, useThreadView } from './use-thread-view'

/**
 * A sub-agent's transcript, which is the ordinary transcript pointed at the child's thread.
 *
 * A component rather than a branch inside the parent's view, because mounting is what scopes it: the
 * child's store, its channel subscription and its clock exist while it is open and go when it is
 * closed, and no reader has to ask whether the thread on screen is a child. The waiting line's
 * absence is structural for the same reason — nothing here has a `background` to pass it, so the
 * one surface that says what the parent is still waiting on cannot appear over a child's log.
 */
export function SubagentTranscript(props: {
  app: AtlasApp
  agent: AgentSnapshot
  thinking: EThinkingVisibility
  width: number
  cwd: string
  opened: ReadonlySet<string>
  onToggle: (key: string) => void
}): React.ReactNode {
  const running = props.agent.status === EAgentStatus.Running

  const view = useThreadView({
    app: props.app,
    threadId: props.agent.agentId,
    rows: EThreadRows.Own,
    thinking: props.thinking,
    readClock: Date.now,
  })

  const now = useTickingNow(running)

  return (
    <Transcript
      model={transcriptOfTurn({ model: view.model, working: running, failure: null })}
      width={props.width}
      now={now}
      cwd={props.cwd}
      turn={turnOfChild({
        observed: view.turn,
        running,
        steppingSince: props.agent.steppingSince ?? null,
      })}
      opened={props.opened}
      onToggle={props.onToggle}
    />
  )
}
