import { ECommandGroup, ECommandKind } from '@dltech/atlas-core'

import { ECompactScope, scopeOfArgument } from '../compact-turn'
import {
  ECommandEcho,
  ECommandEffect,
  ECommandTiming,
  RAN,
  type CommandEffect,
  type LocalCommand,
} from './local-command'

const UNKNOWN_SCOPE = (argumentText: string): string =>
  `/compact takes no argument, or "all" to compact the whole conversation — not ${argumentText.trim()}`

const refused = (reason: string): CommandEffect => ({ type: ECommandEffect.Refused, reason })

export type LocalCommandHandlers = {
  onCompact: (scope: ECompactScope) => void
  onRewind: () => void
  onShortcuts: () => void
  onOpenSwitcher: () => void
  onOpenShells: () => void
  onOpenSettings: () => void
  onOpenAccounts: () => void
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
    immediate({
      name: 'auth',
      summary: 'sign in, switch account, or remove one',
      group: ECommandGroup.Session,
      open: handlers.onOpenAccounts,
    }),
    local({
      name: 'compact',
      summary: 'replace the history so far with a summary',
      argumentHint: '[all]',
      group: ECommandGroup.Context,
      timing: ECommandTiming.Settled,
      echo: ECommandEcho.Name,
      run: ({ argumentText }) => {
        const scope = scopeOfArgument(argumentText)
        if (scope === null) return refused(UNKNOWN_SCOPE(argumentText))

        handlers.onCompact(scope)
        return RAN
      },
    }),
    immediate({
      name: 'rewind',
      summary: 'go back to an earlier message, or summarise around it',
      group: ECommandGroup.Context,
      open: handlers.onRewind,
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
