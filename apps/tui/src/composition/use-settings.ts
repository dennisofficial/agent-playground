import {
  activateSetting,
  adjustSetting,
  choiceValueOf,
  DEFAULT_WARN_PERCENT,
  ESettingId,
  EUsageWindow,
  rangeValueOf,
  toggleValueOf,
  type ResolvedSetting,
  type SettingValue,
} from '@dltech/atlas-core'
import type { KeyEvent } from '@opentui/core'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { appearanceOf, applyAppearance } from '../ui/appearance'
import {
  EFooterMeters,
  footerMetersOf,
  SHIPPED_FOOTER_METERS,
} from '../ui/usage-meters'
import { SHIPPED_THINKING, thinkingVisibilityOf, type EThinkingVisibility } from '../store'

const AUTO_COMPACT_AT_PERCENT = 90
import {
  currentRow,
  movePage,
  moveRow,
  openSettings,
  settingsModel,
  type SettingsModel,
  type SettingsState,
} from '../ui/settings-model'
import { SIDEBAR_WIDTH } from '../ui/theme'
import type { AtlasApp } from './compose'

export type SettingsControl = {
  view: SettingsModel
  state: SettingsState | null
  origin: string
  problem: string | undefined
  sidebarWidth: number
  autoCompactAtPercent: number
  paceReveal: boolean
  thinking: EThinkingVisibility
  footerMeters: EFooterMeters
  usageWarn: Record<EUsageWindow, number>
  handleOpen: () => void
  handleDismiss: () => void
  handleActivate: (target: SettingsState) => void
  handleKey: (key: KeyEvent) => void
}

export function useSettings(args: { app: AtlasApp }): SettingsControl {
  const { app } = args
  useSyncExternalStore(app.settings.subscribe, app.settings.version)
  const held = app.settings.snapshot()

  const [state, setState] = useState<SettingsState | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  const view = useMemo(
    () => settingsModel({ definitions: app.settings.definitions, resolution: held.resolution }),
    [app.settings.definitions, held.resolution],
  )

  const { accent, density, composer } = appearanceOf({ resolution: held.resolution })

  useEffect(() => {
    applyAppearance({ accent, density, composer })
  }, [accent, composer, density])

  const write = useCallback(
    (target: SettingsState, next: (row: ResolvedSetting) => SettingValue) => {
      const row = currentRow({ state: target, model: view })
      if (row === undefined) return

      const written = app.settings.set({ id: row.definition.id, value: next(row) })
      setRefused(written.ok ? null : written.message)
    },
    [app.settings, view],
  )

  const handleOpen = useCallback(() => setState(openSettings()), [])

  const handleDismiss = useCallback(() => {
    setState(null)
    setRefused(null)
  }, [])

  const handleActivate = useCallback(
    (target: SettingsState) => {
      setState(target)
      write(target, (row) => activateSetting({ definition: row.definition, current: row.value }))
    },
    [write],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return
      key.preventDefault()

      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === 'tab') {
        setState(movePage({ state, model: view, delta: key.shift ? -1 : 1 }))
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        setState(moveRow({ state, model: view, delta: key.name === 'up' ? -1 : 1 }))
        return
      }

      if (key.name === 'return') {
        handleActivate(state)
        return
      }

      if (key.name === 'left' || key.name === 'right') {
        write(state, (row) =>
          adjustSetting({
            definition: row.definition,
            current: row.value,
            delta: key.name === 'left' ? -1 : 1,
          }),
        )
      }
    },
    [handleActivate, handleDismiss, state, view, write],
  )

  return {
    view,
    state,
    origin: held.writesTo,
    problem: refused ?? held.problems[0],
    sidebarWidth: rangeValueOf({
      resolution: held.resolution,
      id: ESettingId.SidebarWidth,
      fallback: SIDEBAR_WIDTH,
    }),
    autoCompactAtPercent: rangeValueOf({
      resolution: held.resolution,
      id: ESettingId.AutoCompact,
      fallback: AUTO_COMPACT_AT_PERCENT,
    }),
    paceReveal: toggleValueOf({ resolution: held.resolution, id: ESettingId.SmoothStreaming }),
    footerMeters: footerMetersOf(
      choiceValueOf({
        resolution: held.resolution,
        id: ESettingId.FooterMeters,
        fallback: SHIPPED_FOOTER_METERS,
      }),
    ),
    usageWarn: {
      [EUsageWindow.FiveHour]: rangeValueOf({
        resolution: held.resolution,
        id: ESettingId.WarnFiveHour,
        fallback: DEFAULT_WARN_PERCENT[EUsageWindow.FiveHour],
      }),
      [EUsageWindow.SevenDay]: rangeValueOf({
        resolution: held.resolution,
        id: ESettingId.WarnWeekly,
        fallback: DEFAULT_WARN_PERCENT[EUsageWindow.SevenDay],
      }),
    },
    thinking: thinkingVisibilityOf(
      choiceValueOf({
        resolution: held.resolution,
        id: ESettingId.ThinkingBlocks,
        fallback: SHIPPED_THINKING,
      }),
    ),
    handleOpen,
    handleDismiss,
    handleActivate,
    handleKey,
  }
}
