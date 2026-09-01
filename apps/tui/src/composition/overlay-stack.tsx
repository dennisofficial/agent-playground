import { MODEL_CATALOG } from '@dltech/atlas-core'
import React from 'react'

import { Accounts } from '../ui/components/accounts'
import type { Span } from '../ui/components/spans'
import type { AccountRow } from '../ui/accounts-model'
import { CompactingOverlay, type Compacting } from '../ui/components/compacting'
import { ExitGuard } from '../ui/components/exit-guard'
import { exitGuardAgentRow, exitGuardRow } from '../ui/exit-guard-model'
import { Rewind } from '../ui/components/rewind'
import { Settings } from '../ui/components/settings'
import { Shells } from '../ui/components/shells'
import { Switcher } from '../ui/components/switcher'
import { Threads } from '../ui/components/threads'
import { AgentsPicker } from '../ui/components/agents-picker'
import { isShellRunning } from '../ui/shells-model'
import { isSubagentRunning } from '../store/subagent-row'
import { modelIsReachable } from './model-selection'
import type { AccountsControl } from './use-accounts'
import type { AgentsControl } from './use-agents'
import type { AgentsPickerControl } from './use-agents-picker'
import type { ExitGuardControl } from './use-exit-guard'
import type { RewindControl } from './use-rewind'
import type { SettingsControl } from './use-settings'
import type { ShellsControl } from './use-shells'
import type { SwitcherControl } from './use-switcher'
import type { ThreadsControl } from './use-threads'

export function OverlayStack(props: {
  width: number
  contentWidth: number
  cwd: string
  activeModelId: string
  switcher: SwitcherControl
  shells: ShellsControl
  agents: AgentsControl
  agentsPicker: AgentsPickerControl
  settings: SettingsControl
  accounts: AccountsControl
  threads: ThreadsControl
  accountMeters: (row: AccountRow) => readonly Span[]
  rewind: RewindControl
  exitGuard: ExitGuardControl
  compacting: Compacting | null
  now: number
}): React.ReactNode {
  const { switcher, shells, agents, agentsPicker, settings, accounts, threads, rewind, exitGuard } =
    props
  const sidebarWidth = Math.min(settings.sidebarWidth, props.width)

  return (
    <>
      {props.compacting === null ? null : (
        <CompactingOverlay compacting={props.compacting} now={props.now} width={props.width} />
      )}
      {rewind.state === null ? null : (
        <Rewind
          width={Math.min(props.contentWidth, props.width)}
          state={rewind.state}
          overlay
          onPick={rewind.handlePick}
          onDismiss={rewind.handleDismiss}
        />
      )}
      {accounts.state === null ? null : (
        <Accounts
          width={sidebarWidth}
          state={accounts.state}
          meters={props.accountMeters}
          overlay
          onPick={accounts.handlePick}
          onDismiss={accounts.handleDismiss}
          onOpenUrl={accounts.handleOpenUrl}
        />
      )}
      {threads.state === null ? null : (
        <Threads
          width={sidebarWidth}
          state={threads.state}
          overlay
          onPick={threads.handlePick}
          onDismiss={threads.handleDismiss}
        />
      )}
      {agentsPicker.state === null ? null : (
        <AgentsPicker
          width={sidebarWidth}
          state={agentsPicker.state}
          overlay
          onPick={agentsPicker.handlePick}
          onDismiss={agentsPicker.handleDismiss}
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
          scroll={shells.scroll}
          overlay
          onKill={shells.handleKill}
          onDismiss={shells.handleDismiss}
        />
      )}
      {exitGuard.state === null ? null : (
        <ExitGuard
          width={Math.min(props.contentWidth, props.width)}
          running={[
            ...shells.everywhere.filter(isShellRunning).map(exitGuardRow),
            ...agents.everywhere.filter(isSubagentRunning).map(exitGuardAgentRow),
          ]}
          state={exitGuard.state}
          overlay
          onPick={exitGuard.handlePick}
          onDismiss={exitGuard.handleDismiss}
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
          appearance={settings.appearance}
          problem={settings.problem}
          onActivate={settings.handleActivate}
          onDismiss={settings.handleDismiss}
        />
      )}
    </>
  )
}
