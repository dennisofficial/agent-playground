import { ECommandGroup, ECommandKind, EExecutionLocation } from '@dltech/atlas-core'

import { ECompactScope, scopeOfArgument } from '../compact-turn'
import { ERenamed } from '../session-rename'
import type { Renaming } from '../session-rename'
import { reloadNotice, type SkillsReloaded } from '../skills-reload'
import { NOTHING_WAS_LOST } from '../../ui/lost-children-model'
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

const NOTHING_SAID_YET =
  '/rename has nothing to read yet — say what this conversation should be called, as in /rename Doing something cool'

const NO_NAME_CAME_BACK =
  '/rename could not think of a name for this conversation — say one, as in /rename Doing something cool'

const NO_SUBAGENTS = 'this conversation has spawned no sub-agent to read'

const UNKNOWN_AGENTS_ARGUMENT = (argumentText: string): string =>
  `/agents takes no argument to read a sub-agent of this conversation, "types" to list the agent types on disk, or "lost" to name the ones this conversation opened without recording — not ${argumentText.trim()}`

const refused = (reason: string): CommandEffect => ({ type: ECommandEffect.Refused, reason })

export enum EAgentsAsk {
  Children = 'children',
  Types = 'types',
  Lost = 'lost',
}

export const agentsAskOfArgument = (argumentText: string): EAgentsAsk | null => {
  const asked = argumentText.trim().toLowerCase()
  if (asked === '') return EAgentsAsk.Children
  if (asked === 'types') return EAgentsAsk.Types
  if (asked === 'lost') return EAgentsAsk.Lost
  return null
}

export enum EContainerAsk {
  Current = 'current',
}

export const containerAskOfArgument = (
  argumentText: string,
): EExecutionLocation | EContainerAsk | null => {
  const asked = argumentText.trim().toLowerCase()
  if (asked === '') return EContainerAsk.Current
  if (asked === 'off' || asked === 'host') return EExecutionLocation.Host
  if (asked === 'docker') return EExecutionLocation.Docker
  return null
}

const unknownContainerArgument = (argumentText: string): string =>
  `/container takes no argument to say where this conversation runs, or "off" | "docker" to move it — not ${argumentText.trim()}`

export type LocalCommandHandlers = {
  onContainer: (asked: EExecutionLocation | EContainerAsk) => string
  onCompact: (scope: ECompactScope) => void
  onRewind: () => void
  onShortcuts: () => void
  onOpenSwitcher: () => void
  onOpenShells: () => void
  onOpenAgents: () => boolean
  onShowAgentTypes: () => void
  onShowLostAgents: () => boolean
  onOpenSettings: () => void
  onOpenAccounts: () => void
  onNewConversation: () => void
  onOpenThreads: (handle: string) => void
  onRename: (argumentText: string) => Promise<Renaming>
  onReloadSkills: () => Promise<SkillsReloaded>
  onShowMcp: () => string
  onRestart: (() => void) | null
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
    local({
      name: 'container',
      summary: 'move this conversation between the host and a docker container',
      argumentHint: '[off|docker]',
      group: ECommandGroup.Session,
      timing: ECommandTiming.Immediate,
      echo: ECommandEcho.Output,
      run: ({ argumentText }) => {
        const asked = containerAskOfArgument(argumentText)
        if (asked === null) return refused(unknownContainerArgument(argumentText))

        return { type: ECommandEffect.Ran, notice: handlers.onContainer(asked) }
      },
    }),
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
    local({
      name: 'agents',
      summary:
        'read a sub-agent this conversation has spawned, running or finished, or list the agent types on disk',
      argumentHint: '[types|lost]',
      group: ECommandGroup.Session,
      timing: ECommandTiming.Immediate,
      echo: ECommandEcho.Silent,
      run: ({ argumentText }) => {
        const ask = agentsAskOfArgument(argumentText)
        if (ask === null) return refused(UNKNOWN_AGENTS_ARGUMENT(argumentText))

        if (ask === EAgentsAsk.Types) {
          handlers.onShowAgentTypes()
          return RAN
        }

        if (ask === EAgentsAsk.Lost) {
          return handlers.onShowLostAgents() ? RAN : refused(NOTHING_WAS_LOST)
        }

        return handlers.onOpenAgents() ? RAN : refused(NO_SUBAGENTS)
      },
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
    local({
      name: 'rewind',
      summary: 'go back to an earlier message, or summarise around it',
      group: ECommandGroup.Context,
      timing: ECommandTiming.Settled,
      echo: ECommandEcho.Silent,
      run: () => {
        handlers.onRewind()
        return RAN
      },
    }),
    local({
      name: 'resume',
      summary: 'switch to another conversation in this workspace',
      argumentHint: '[conversation]',
      group: ECommandGroup.Session,
      timing: ECommandTiming.Settled,
      echo: ECommandEcho.Silent,
      run: ({ argumentText }) => {
        handlers.onOpenThreads(argumentText.trim())
        return RAN
      },
    }),
    local({
      name: 'rename',
      summary: 'name this conversation, or have it named again from the transcript',
      argumentHint: '[name]',
      group: ECommandGroup.Session,
      timing: ECommandTiming.Immediate,
      echo: ECommandEcho.Silent,
      run: async ({ argumentText }) => {
        const renaming = await handlers.onRename(argumentText)
        if (renaming.type === ERenamed.Empty) return refused(NOTHING_SAID_YET)
        if (renaming.type === ERenamed.Declined) return refused(NO_NAME_CAME_BACK)

        return RAN
      },
    }),
    local({
      name: 'skills',
      summary: 'read the skill folders again, picking up anything added since launch',
      group: ECommandGroup.Workspace,
      timing: ECommandTiming.Immediate,
      echo: ECommandEcho.Output,
      run: async () => {
        const reloaded = await handlers.onReloadSkills()
        return { type: ECommandEffect.Ran, notice: reloadNotice(reloaded) }
      },
    }),
    local({
      name: 'new',
      aliases: ['clear'],
      summary: 'start a fresh conversation',
      group: ECommandGroup.Session,
      timing: ECommandTiming.Settled,
      echo: ECommandEcho.Silent,
      run: () => {
        handlers.onNewConversation()
        return RAN
      },
    }),
    ...(handlers.onRestart === null
      ? []
      : [
          local({
            name: 'restart',
            summary: 'rebuild from source and restart, resuming this conversation',
            group: ECommandGroup.Session,
            timing: ECommandTiming.Settled,
            echo: ECommandEcho.Silent,
            run: () => {
              handlers.onRestart?.()
              return RAN
            },
          }),
        ]),
    local({
      name: 'mcp',
      summary: 'inspect the MCP servers this workspace is configured with',
      group: ECommandGroup.Workspace,
      timing: ECommandTiming.Immediate,
      echo: ECommandEcho.Output,
      run: () => ({ type: ECommandEffect.Ran, notice: handlers.onShowMcp() }),
    }),
  ]
}
