import type { ModelRef } from '@dltech/atlas-core'
import React from 'react'

import { Accounts } from '../ui/components/accounts'
import { Approval } from '../ui/components/approval'
import type { Span } from '../ui/components/spans'
import type { AccountRow } from '../ui/accounts-model'
import { CompactingOverlay, type Compacting } from '../ui/components/compacting'
import { ExitGuard } from '../ui/components/exit-guard'
import { exitGuardAgentRow, exitGuardRow, exitGuardServiceRow } from '../ui/exit-guard-model'
import { Rewind } from '../ui/components/rewind'
import { Services } from '../ui/components/services'
import { Settings } from '../ui/components/settings'
import { Shells } from '../ui/components/shells'
import { Switcher } from '../ui/components/switcher'
import { Threads } from '../ui/components/threads'
import { AgentsPicker } from '../ui/components/agents-picker'
import { isServiceAlive } from '../ui/services-model'
import { isShellRunning } from '../ui/shells-model'
import { isSubagentRunning } from '../store/subagent-row'
import type { AccountsControl } from './use-accounts'
import type { AgentsControl } from './use-agents'
import type { AgentsPickerControl } from './use-agents-picker'
import type { ApprovalControl } from './use-approval'
import type { ExitGuardControl } from './use-exit-guard'
import type { RewindControl } from './use-rewind'
import type { ServicesControl } from './use-services'
import type { SettingsControl } from './use-settings'
import type { ShellsControl } from './use-shells'
import { type SwitcherControl } from './use-switcher'
import type { ThreadsControl } from './use-threads'

export function OverlayStack(props: {
  width: number
  contentWidth: number
  cwd: string
  active: ModelRef
  switcher: SwitcherControl
  shells: ShellsControl
  services: ServicesControl
  agents: AgentsControl
  agentsPicker: AgentsPickerControl
  settings: SettingsControl
  accounts: AccountsControl
  threads: ThreadsControl
  accountMeters: (row: AccountRow) => readonly Span[]
  rewind: RewindControl
  approval: ApprovalControl
  exitGuard: ExitGuardControl
  compacting: Compacting | null
  now: number
}): React.ReactNode {
  const { switcher, shells, agents, agentsPicker, settings, accounts, threads, rewind, exitGuard } =
    props
  const { approval } = props
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
          width={props.width}
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
          width={Math.min(props.contentWidth, props.width)}
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
          rows={switcher.rows}
          state={switcher.state}
          active={props.active}
          total={switcher.total}
          query={switcher.query}
          target={switcher.target}
          overlay
          onPick={switcher.handlePick}
          onSelect={switcher.handleSelect}
          onDismiss={switcher.handleDismiss}
          onQueryChange={switcher.handleQuery}
        />
      )}
      {shells.state === null ? null : (
        <Shells
          width={Math.min(props.contentWidth, props.width)}
          shells={shells.shells}
          now={shells.now}
          selected={shells.selected}
          output={shells.output}
          scroll={shells.scroll}
          overlay
          onKill={shells.handleKill}
          onDismiss={shells.handleDismiss}
        />
      )}
      {props.services.state === null ? null : (
        <Services
          width={Math.min(props.contentWidth, props.width)}
          services={props.services.services}
          now={props.services.now}
          selected={props.services.selected}
          log={props.services.log}
          scroll={props.services.scroll}
          overlay
          onStop={props.services.handleStop}
          onDismiss={props.services.handleDismiss}
        />
      )}
      {approval.state === null ? null : (
        <Approval
          width={Math.min(props.contentWidth, props.width)}
          state={approval.state}
          overlay
          onPick={approval.handlePick}
          onDismiss={approval.handleDismiss}
        />
      )}
      {exitGuard.state === null ? null : (
        <ExitGuard
          width={Math.min(props.contentWidth, props.width)}
          running={[
            ...shells.everywhere.filter(isShellRunning).map(exitGuardRow),
            ...props.services.everywhere.filter(isServiceAlive).map(exitGuardServiceRow),
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
          prompt={settings.prompt}
          secretOf={settings.secretOf}
          secretOrigin={settings.secretOrigin}
          problem={settings.problem}
          onActivate={settings.handleActivate}
          onDismiss={settings.handleDismiss}
        />
      )}
    </>
  )
}
