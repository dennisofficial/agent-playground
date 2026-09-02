import { refKey, type ThreadId } from '@dltech/atlas-core'
import type { ThreadModel } from '@dltech/atlas-harness'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import type { SwitcherChoice } from '../ui/switcher-model'
import type { AtlasApp } from './compose'
import type { ModelSelection } from './model-selection'
import { defaultSelection, rememberDefault, storedModel, threadSelection } from './model-preference'
import { EModelScope } from './use-switcher'

export type ThreadModelControl = {
  selection: ModelSelection
  fallback: ModelSelection
  handlePicked: (args: { choice: SwitcherChoice; scope: EModelScope }) => void
}

/**
 * Two preferences, one picker. A conversation carries the model it was last switched to, so two
 * terminals on two threads stop fighting over one remembered pair; the settings row carries what a
 * conversation with nothing of its own begins on.
 *
 * The default is read where the thread is adopted rather than followed, so raising it in the
 * settings reaches the next conversation instead of the one on screen. The order of the effects is
 * the other invariant: the thread's pair reaches the harness before anything is written back, so
 * the write sees the model this thread is on rather than the one the thread before it left behind.
 */
export function useThreadModel(args: {
  app: AtlasApp
  threadId: ThreadId
  stored: ThreadModel | undefined
  started: boolean
}): ThreadModelControl {
  const { app, threadId, stored, started } = args
  const [selection, setSelection] = useState<ModelSelection>(() => app.model.choice())
  const launching = useRef(true)
  const wasStarted = useRef(started)

  useSyncExternalStore(app.settings.subscribe, app.settings.version)
  const { resolution } = app.settings.snapshot()

  const fallback = useMemo(
    () => defaultSelection({ settled: resolution, catalogue: app.models }),
    [app.models, resolution],
  )

  useEffect(() => {
    const pinned = launching.current && app.modelPinned
    launching.current = false
    if (pinned) return

    app.model.select(
      threadSelection({
        stored,
        fallback: defaultSelection({
          settled: app.settings.snapshot().resolution,
          catalogue: app.models,
        }),
        catalogue: app.models,
      }),
    )
    setSelection(app.model.choice())
  }, [app, stored, threadId])

  useEffect(() => {
    const opening = !wasStarted.current && started
    wasStarted.current = started
    if (!opening) return

    void app.threads
      .chooseModel({ threadId, model: storedModel(app.model.choice()) })
      .catch(() => undefined)
  }, [app, started, threadId])

  const handlePicked = useCallback(
    ({ choice, scope }: { choice: SwitcherChoice; scope: EModelScope }) => {
      if (choice.ref === null) return

      const next: ModelSelection = { ref: choice.ref, effort: choice.effort }

      if (scope === EModelScope.Default) {
        rememberDefault({ settings: app.settings, selection: next })
        return
      }

      app.model.select(next)
      const landed = app.model.choice()
      setSelection(landed)
      if (refKey(landed.ref) !== refKey(next.ref)) return

      if (!started) return

      void app.threads.chooseModel({ threadId, model: storedModel(landed) }).catch(() => undefined)
    },
    [app, started, threadId],
  )

  return { selection, fallback, handlePicked }
}
