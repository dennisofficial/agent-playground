import { ERenamed, type Renaming } from '../../session-rename'
import type { SkillsReloaded } from '../../skills-reload'
import type { LocalCommandHandlers } from '../registry'

export const stub = (): undefined => undefined

const NOTHING_RELOADED: SkillsReloaded = { loaded: 0, added: [], removed: [] }

const renamed = async (argumentText: string): Promise<Renaming> => ({
  type: ERenamed.Renamed,
  name: argumentText,
})

export const handlers = (
  overrides: Partial<LocalCommandHandlers> = {},
): LocalCommandHandlers => ({
  onCompact: stub,
  onRewind: stub,
  onShortcuts: stub,
  onOpenSwitcher: stub,
  onOpenShells: stub,
  onOpenAgents: () => true,
  onShowAgentTypes: stub,
  onShowLostAgents: () => true,
  onOpenSettings: stub,
  onOpenAccounts: stub,
  onNewConversation: stub,
  onOpenThreads: stub,
  onRename: renamed,
  onReloadSkills: async () => NOTHING_RELOADED,
  onShowMcp: () => 'no MCP servers are configured',
  onRestart: null,
  ...overrides,
})
