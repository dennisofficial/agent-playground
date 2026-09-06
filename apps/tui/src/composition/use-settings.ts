import {
  activateSetting,
  adjustSetting,
  choiceValueOf,
  DEFAULT_WARN_PERCENT,
  ESettingId,
  ESettingKind,
  EUsageWindow,
  formatFavourites,
  parseFavourites,
  rangeValueOf,
  textValueOf,
  toggleValueOf,
  type ResolvedSetting,
  type SecretPrompt,
  type SettingValue,
  type SettingsResolution,
} from '@dltech/atlas-core'
import type { KeyEvent } from '@opentui/core'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { appearanceOf, applyAppearance, type Appearance } from '../ui/appearance'
import {
  EFooterMeters,
  footerMetersOf,
  SHIPPED_FOOTER_METERS,
} from '../ui/usage-meters'
import { SHIPPED_THINKING, thinkingVisibilityOf, type EThinkingVisibility } from '../store'

const AUTO_COMPACT_AT_PERCENT = 90

const NOTICE_SECONDS = 2
import {
  currentRow,
  movePage,
  moveRow,
  openSettings,
  settingsModel,
  type SettingsModel,
  type SettingsState,
} from '../ui/settings-model'
import { SIDEBAR_FOLD_BELOW, SIDEBAR_WIDTH } from '../ui/theme'
import type { Span } from '../ui/components/spans'
import type { AtlasApp } from './compose'
import { useSecretPrompt } from './use-secret-prompt'

export type SettingsControl = {
  view: SettingsModel
  appearance: Appearance
  state: SettingsState | null
  prompt: SecretPrompt | null
  secretOf: (id: string) => Span | undefined
  secretOrigin: string
  origin: string
  problem: string | undefined
  sidebarWidth: number
  sidebarFoldBelow: number
  autoCompactAtPercent: number
  autoRestart: boolean
  noticeSeconds: number
  paceReveal: boolean
  thinking: EThinkingVisibility
  tldrStatus: boolean
  footerMeters: EFooterMeters
  usageWarn: Record<EUsageWindow, number>
  modelFavourites: readonly string[]
  handlePinModels: (favourites: readonly string[]) => void
  handleOpen: () => void
  handleDismiss: () => void
  handleActivate: (target: SettingsState) => void
  handleKey: (key: KeyEvent) => void
}

type Preferences = Pick<
  SettingsControl,
  | 'sidebarWidth'
  | 'sidebarFoldBelow'
  | 'autoCompactAtPercent'
  | 'autoRestart'
  | 'noticeSeconds'
  | 'paceReveal'
  | 'footerMeters'
  | 'usageWarn'
  | 'thinking'
  | 'tldrStatus'
  | 'modelFavourites'
>

const preferencesOf = (resolution: SettingsResolution): Preferences => ({
  sidebarWidth: rangeValueOf({ resolution, id: ESettingId.SidebarWidth, fallback: SIDEBAR_WIDTH }),
  sidebarFoldBelow: rangeValueOf({
    resolution,
    id: ESettingId.SidebarFoldBelow,
    fallback: SIDEBAR_FOLD_BELOW,
  }),
  autoCompactAtPercent: rangeValueOf({
    resolution,
    id: ESettingId.AutoCompact,
    fallback: AUTO_COMPACT_AT_PERCENT,
  }),
  autoRestart: toggleValueOf({ resolution, id: ESettingId.AutoRestart }),
  noticeSeconds: rangeValueOf({ resolution, id: ESettingId.NoticeSeconds, fallback: NOTICE_SECONDS }),
  paceReveal: toggleValueOf({ resolution, id: ESettingId.SmoothStreaming }),
  footerMeters: footerMetersOf(
    choiceValueOf({ resolution, id: ESettingId.FooterMeters, fallback: SHIPPED_FOOTER_METERS }),
  ),
  usageWarn: {
    [EUsageWindow.FiveHour]: rangeValueOf({
      resolution,
      id: ESettingId.WarnFiveHour,
      fallback: DEFAULT_WARN_PERCENT[EUsageWindow.FiveHour],
    }),
    [EUsageWindow.SevenDay]: rangeValueOf({
      resolution,
      id: ESettingId.WarnWeekly,
      fallback: DEFAULT_WARN_PERCENT[EUsageWindow.SevenDay],
    }),
  },
  thinking: thinkingVisibilityOf(
    choiceValueOf({ resolution, id: ESettingId.ThinkingBlocks, fallback: SHIPPED_THINKING }),
  ),
  tldrStatus: toggleValueOf({ resolution, id: ESettingId.TldrStatus }),
  modelFavourites: parseFavourites(textValueOf({ resolution, id: ESettingId.ModelFavourites })),
})

export function useSettings(args: {
  app: AtlasApp
  onChooseModel: () => void
}): SettingsControl {
  const { app, onChooseModel } = args
  useSyncExternalStore(app.settings.subscribe, app.settings.version)
  const held = app.settings.snapshot()

  const [state, setState] = useState<SettingsState | null>(null)
  const [refused, setRefused] = useState<string | null>(null)


  const view = useMemo(
    () => settingsModel({ definitions: app.settings.definitions, resolution: held.resolution }),
    [app.settings.definitions, held.resolution],
  )

  const { accent, density, composer, imageRows, fenceWrap } = appearanceOf({
    resolution: held.resolution,
  })

  const appearance = useMemo(
    () => ({ accent, density, composer, imageRows, fenceWrap }),
    [accent, composer, density, imageRows, fenceWrap],
  )

  useEffect(() => {
    applyAppearance(appearance)
  }, [appearance])

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

  const handlePinModels = useCallback(
    (favourites: readonly string[]) => {
      app.settings.set({
        id: ESettingId.ModelFavourites,
        value: formatFavourites(favourites),
      })
    },
    [app.settings],
  )

  const secret = useSecretPrompt({ secrets: app.secrets, resolution: held.resolution })

  const handleDismiss = useCallback(() => {
    setState(null)
    setRefused(null)
    secret.close()
  }, [secret])

  const handleActivate = useCallback(
    (target: SettingsState) => {
      setState(target)

      const row = currentRow({ state: target, model: view })
      if (row === undefined) return

      if (row.definition.kind === ESettingKind.Secret) {
        secret.open(row.definition.id)
        return
      }

      if (row.definition.kind === ESettingKind.Model) {
        onChooseModel()
        return
      }

      write(target, (held) => activateSetting({ definition: held.definition, current: held.value }))
    },
    [onChooseModel, secret, view, write],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return
      key.preventDefault()

      if (secret.prompt !== null) {
        secret.handleKey(key, secret.prompt)
        return
      }

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
    [handleActivate, handleDismiss, secret, state, view, write],
  )

  const preferences = useMemo(() => preferencesOf(held.resolution), [held.resolution])
  const problem = refused ?? held.problems[0]
  const origin = held.writesTo

  return useMemo(
    () => ({
      view,
      appearance,
      state,
      prompt: secret.prompt,
      secretOf: secret.displayOf,
      secretOrigin: secret.origin,
      origin,
      problem,
      ...preferences,
      handlePinModels,
      handleOpen,
      handleDismiss,
      handleActivate,
      handleKey,
    }),
    [
      appearance,
      handleActivate,
      handleDismiss,
      handleKey,
      handleOpen,
      handlePinModels,
      origin,
      preferences,
      problem,
      secret,
      state,
      view,
    ],
  )
}
