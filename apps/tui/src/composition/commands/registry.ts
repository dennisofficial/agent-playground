import { ECommandGroup, ECommandKind } from '@dltech/atlas-core'

import { ECommandEcho, ECommandTiming, RAN, type LocalCommand } from './local-command'

export type LocalCommandHandlers = {
  onCompact: () => void
  onShortcuts: () => void
  onOpenSwitcher: () => void
  onOpenShells: () => void
  onOpenSettings: () => void
  onNewConversation: () => void
}

const local = (command: Omit<LocalCommand, 'kind'>): LocalCommand => ({
  ...command,
  kind: ECommandKind.Local,
})

const immediate = (args: {
  name: string
  summary: string
  group: ECommandGroup
  open: () => void
}): LocalCommand =>
  local({
    name: args.name,
    summary: args.summary,
    group: args.group,
    timing: ECommandTiming.Immediate,
    echo: ECommandEcho.Silent,
    run: () => {
      args.open()
      return RAN
    },
  })

export function localCommands(handlers: LocalCommandHandlers): readonly LocalCommand[] {
  return [
    immediate({
      name: 'help',
      summary: 'show every keyboard shortcut',
      group: ECommandGroup.Session,
      open: handlers.onShortcuts,
    }),
    immediate({
      name: 'model',
      summary: 'pick a model and a reasoning effort',
      group: ECommandGroup.Session,
      open: handlers.onOpenSwitcher,
    }),
    immediate({
      name: 'shells',
      summary: 'inspect the background shells',
      group: ECommandGroup.Session,
      open: handlers.onOpenShells,
    }),
    immediate({
      name: 'settings',
      summary: 'open settings',
      group: ECommandGroup.Session,
      open: handlers.onOpenSettings,
    }),
    local({
      name: 'compact',
      summary: 'replace the history so far with a summary',
      argumentHint: '[all]',
      group: ECommandGroup.Context,
      timing: ECommandTiming.Settled,
      echo: ECommandEcho.Name,
      run: () => {
        handlers.onCompact()
        return RAN
      },
    }),
    local({
      name: 'new',
      summary: 'start a fresh conversation',
      group: ECommandGroup.Session,
      timing: ECommandTiming.Settled,
      echo: ECommandEcho.Silent,
      run: () => {
        handlers.onNewConversation()
        return RAN
      },
    }),
  ]
}
