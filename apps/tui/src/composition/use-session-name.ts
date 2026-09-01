import { eventsOfType, type Event, type ThreadId } from '@dltech/atlas-core'
import { sanitizedTitle } from '@dltech/atlas-harness'
import { useCallback, useRef, useState, type RefObject } from 'react'

import type { AtlasApp } from './compose'
import { ERenamed, sessionDigest, type Renaming } from './session-rename'

export type SessionName = {
  name: string | null
  setName: (name: string | null) => void
  nameSession: (args: { said: string; opened: Promise<void> }) => void
  renameSession: (argumentText: string) => Promise<Renaming>
}

/**
 * A thread is named once, from the first thing said in it, and the ask is fired and forgotten: a
 * title that never arrives must not hold up the turn it was taken from. `/rename` is the deliberate
 * second pass, so it is awaited, it reads the whole session rather than its opening line, and it
 * closes the automatic ask for good.
 *
 * The title is asked for the moment the first message is sent but written only once the thread that
 * carries it exists, since that thread is opened by the very turn the title was taken from.
 */
export function useSessionName(args: {
  app: AtlasApp
  threadId: ThreadId
  started: RefObject<boolean>
  events: readonly Event[]
  initial: string | null
}): SessionName {
  const { app, threadId, started, events } = args
  const [name, setName] = useState<string | null>(args.initial)
  const asked = useRef<ThreadId | null>(null)

  const nameSession = useCallback(
    ({ said, opened }: { said: string; opened: Promise<void> }) => {
      if (name !== null || asked.current === threadId) return

      asked.current = threadId
      const opening = eventsOfType({ events, type: 'user-said' }).at(0)?.text ?? said

      void Promise.all([app.titler({ text: opening }), opened])
        .then(([named]) => {
          if (named === null) return
          setName(named)
          return app.threads.rename({ threadId, title: named })
        })
        .catch(() => undefined)
    },
    [app, events, name, threadId],
  )

  const nameFromTranscript = useCallback(async (): Promise<Renaming> => {
    const digest = sessionDigest(events)
    if (digest.trim().length === 0) return { type: ERenamed.Empty }

    const generated = await app.titler({ text: digest }).catch(() => null)
    if (generated === null) return { type: ERenamed.Declined }

    return { type: ERenamed.Renamed, name: generated }
  }, [app, events])

  const renameSession = useCallback(
    async (argumentText: string): Promise<Renaming> => {
      if (!started.current) return { type: ERenamed.Empty }

      const given = sanitizedTitle(argumentText)
      const renaming: Renaming =
        given === null ? await nameFromTranscript() : { type: ERenamed.Renamed, name: given }

      if (renaming.type !== ERenamed.Renamed) return renaming

      asked.current = threadId
      setName(renaming.name)
      await app.threads.rename({ threadId, title: renaming.name }).catch(() => undefined)

      return renaming
    },
    [app, nameFromTranscript, started, threadId],
  )

  return { name, setName, nameSession, renameSession }
}
