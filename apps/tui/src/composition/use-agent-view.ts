import type { SaidImage, ThreadId } from '@dltech/atlas-core'
import { EKilledBy, type AgentSnapshot } from '@dltech/atlas-harness'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { isSubagentRunning, subagentLabel } from '../store/subagent-row'
import { EKeyGroup, EKeyLayer, useKeyBindings } from '../ui/keys'
import type { AtlasApp } from './compose'

export type AgentView = {
  viewing: ThreadId | null
  name: string | null
  /** The roster's reading of the open child, which is what its transcript is mounted from. */
  selected: AgentSnapshot | null
  handleSelect: (agentId: string) => void
  handleBack: () => void
  handleCycle: () => boolean
  handleStop: () => void
  handleSay: (said: { text: string; images?: readonly SaidImage[] | undefined }) => Promise<string | null>
}

/**
 * A child is an extension of the thread that spawned it, so viewing one moves the transcript alone.
 * The sidebar, the composer's anchor and the running turn all stay with the parent, which is what
 * keeps this from reading as a jump into another session.
 *
 * Which child is open, and nothing about what it says: the transcript is `SubagentTranscript`, built
 * from the same `useThreadView` the conversation is built from.
 */
export function useAgentView(args: {
  app: AtlasApp
  threadId: ThreadId
  onFocusComposer: () => void
  onProblem: (reason: string) => void
}): AgentView {
  const { app, threadId, onFocusComposer, onProblem } = args
  const agents = app.agents

  const [viewing, setViewing] = useState<ThreadId | null>(null)

  useEffect(() => setViewing(null), [threadId])

  const subscribe = useCallback((listener: () => void) => agents.onChange(listener), [agents])
  const read = useCallback(() => agents.listEverywhere(), [agents])
  const readOwn = useCallback(() => agents.list({ threadId }), [agents, threadId])
  const everywhere = useSyncExternalStore(subscribe, read)
  const own = useSyncExternalStore(subscribe, readOwn)

  const selected = useMemo(
    () => (viewing === null ? undefined : everywhere.find((one) => one.agentId === viewing)),
    [everywhere, viewing],
  )

  /**
   * A press on a sidebar row takes the keyboard with it, and the composer's `focused` prop is
   * already true so nothing re-asserts it. Typing to the child is the whole point of selecting one,
   * so the focus is handed back explicitly.
   */
  const handleSelect = useCallback(
    (agentId: string) => {
      setViewing((current) => (current === agentId ? null : (agentId as ThreadId)))
      onFocusComposer()
    },
    [onFocusComposer],
  )

  const handleBack = useCallback(() => {
    setViewing(null)
    onFocusComposer()
  }, [onFocusComposer])

  /**
   * The parent sits at the end of the ring rather than outside it, so the same chord that walks into
   * the crew also walks back out — escape stays the shortcut, not the only way.
   */
  const handleCycle = useCallback((): boolean => {
    if (own.length === 0) return false

    const at = viewing === null ? -1 : own.findIndex((one) => one.agentId === viewing)
    setViewing(own[at + 1]?.agentId ?? null)
    onFocusComposer()
    return true
  }, [onFocusComposer, own, viewing])

  /**
   * Both refusals the supervisor can give — an agent it does not hold, a type no longer on disk —
   * mean this child can never be addressed again, so the view comes back to the parent where the
   * caller's report of the reason is actually on screen.
   */
  const handleSay = useCallback(
    async (said: {
      text: string
      images?: readonly SaidImage[] | undefined
    }): Promise<string | null> => {
      if (viewing === null) return null

      const outcome = await agents.say({ agentId: viewing, threadId, ...said })
      if (outcome.ok) return null

      handleBack()
      return outcome.reason
    },
    [agents, handleBack, threadId, viewing],
  )

  /**
   * Stopping a child is killing a background job, so it reads as one: the child stays on screen
   * afterwards, because its log is the record of what the operator just cut short.
   */
  const handleStop = useCallback((): void => {
    if (viewing === null) return

    const outcome = agents.stop({ agentId: viewing, threadId, by: EKilledBy.User })
    if (!outcome.ok) onProblem(outcome.reason)
  }, [agents, onProblem, threadId, viewing])

  const stoppable = selected !== undefined && isSubagentRunning(selected)

  useKeyBindings(
    viewing === null
      ? []
      : [
          {
            chord: 'escape',
            hint: 'back to the parent',
            layer: EKeyLayer.Block,
            group: EKeyGroup.Session,
            run: handleBack,
          },
          ...(stoppable
            ? [
                {
                  chord: 'ctrl+k',
                  hint: 'stop this sub-agent',
                  describe: 'stop the sub-agent you are reading, the way ctrl+t stops a shell',
                  layer: EKeyLayer.Block,
                  group: EKeyGroup.Session,
                  run: handleStop,
                },
              ]
            : []),
        ],
  )

  return useMemo(
    () => ({
      viewing,
      name: selected === undefined ? null : subagentLabel(selected),
      selected: selected ?? null,
      handleSelect,
      handleBack,
      handleCycle,
      handleStop,
      handleSay,
    }),
    [handleBack, handleCycle, handleSay, handleSelect, handleStop, selected, viewing],
  )
}
