import { homedir } from 'node:os'

import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import React, { useEffect, useState, useSyncExternalStore } from 'react'

import { Startup } from '../ui/components/startup'
import { App } from './app'
import { bootStepLabel, type BootProgress } from './boot-progress'
import type { AtlasApp } from './compose'
import type { OpenedConversation } from './open-conversation'
import { ESession, type Session } from './open-session'
import { useStartup } from './use-startup'

type ReadySession = {
  app: AtlasApp
  opened: OpenedConversation
  credentialNotice: string | null
}

function useReadySession(session: Promise<Session>): ReadySession | null {
  const [ready, setReady] = useState<ReadySession | null>(null)

  useEffect(() => {
    let live = true

    void session.then((settled) => {
      if (!live || settled.type !== ESession.Ready) return
      setReady({
        app: settled.app,
        opened: settled.opened,
        credentialNotice: settled.credentialNotice,
      })
    })

    return () => {
      live = false
    }
  }, [session])

  return ready
}

/**
 * The workspace mounts under the curtain rather than after it, so the settling the curtain hides is
 * real settling: by the time it lifts, the palette, the density and the transcript are all final.
 */
export function BootScreen(props: {
  session: Promise<Session>
  progress: BootProgress
  cwd: string
  onAbandon: () => void
}): React.ReactNode {
  const { width, height } = useTerminalDimensions()
  const step = useSyncExternalStore(props.progress.subscribe, props.progress.step)
  const ready = useReadySession(props.session)
  const startup = useStartup({ ready: ready !== null })

  /**
   * The renderer holds the terminal in raw mode from the first frame, so ctrl+c is Atlas's to
   * answer well before the harness exists to answer it. Nothing else can hurry the curtain along
   * until there is a workspace behind it to hurry along to.
   */
  useKeyboard((key) => {
    if (ready === null) {
      if (key.ctrl && key.name === 'c') props.onAbandon()
      return
    }
    if (startup.covered) startup.handleSkip()
  })

  return (
    <>
      {ready === null ? null : (
        <App
          app={ready.app}
          opened={ready.opened}
          credentialNotice={ready.credentialNotice}
          covered={startup.covered}
        />
      )}
      {startup.covered ? (
        <Startup
          frame={startup.frame}
          width={width}
          height={height}
          status={bootStepLabel(step)}
          cwd={props.cwd}
          home={homedir()}
        />
      ) : null}
    </>
  )
}
