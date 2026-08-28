import { MODEL_CATALOG } from '@dltech/atlas-core'
import React from 'react'

import { Rewind } from '../ui/components/rewind'
import { Settings } from '../ui/components/settings'
import { Shells } from '../ui/components/shells'
import { Switcher } from '../ui/components/switcher'
import { modelIsReachable } from './model-selection'
import type { RewindControl } from './use-rewind'
import type { SettingsControl } from './use-settings'
import type { ShellsControl } from './use-shells'
import type { SwitcherControl } from './use-switcher'

export function OverlayStack(props: {
  width: number
  contentWidth: number
  cwd: string
  activeModelId: string
  switcher: SwitcherControl
  shells: ShellsControl
  settings: SettingsControl
  rewind: RewindControl
}): React.ReactNode {
  const { switcher, shells, settings, rewind } = props
  const sidebarWidth = Math.min(settings.sidebarWidth, props.width)

  return (
    <>
      {rewind.state === null ? null : (
        <Rewind
          width={Math.min(props.contentWidth, props.width)}
          state={rewind.state}
          overlay
          onPick={rewind.handlePick}
          onDismiss={rewind.handleDismiss}
        />
      )}
      {switcher.state === null ? null : (
        <Switcher
          width={sidebarWidth}
          models={MODEL_CATALOG}
          state={switcher.state}
          activeModelId={props.activeModelId}
          availability={modelIsReachable}
          overlay
          onPick={switcher.handlePick}
          onDismiss={switcher.handleDismiss}
        />
      )}
      {shells.state === null ? null : (
        <Shells
          width={Math.min(props.contentWidth, props.width)}
          shells={shells.shells}
          selected={shells.selected}
          output={shells.output}
          overlay
          onKill={shells.handleKill}
          onDismiss={shells.handleDismiss}
        />
      )}
      {settings.state === null ? null : (
        <Settings
          width={props.width}
          sidebarWidth={sidebarWidth}
          model={settings.view}
          state={settings.state}
          cwd={props.cwd}
          origin={settings.origin}
          problem={settings.problem}
          onActivate={settings.handleActivate}
          onDismiss={settings.handleDismiss}
        />
      )}
    </>
  )
}
