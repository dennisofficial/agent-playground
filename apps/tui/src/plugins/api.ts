import {
  AfterShellHook,
  AfterToolHook,
  AfterTurnHook,
  BeforeRequestHook,
  BeforeStepHook,
  BeforeToolHook,
  BeforeTurnHook,
  EBeforeToolDecision,
  EDefinitionOrigin,
  EHookPhase,
  EReadConfidence,
  EStage,
  EToolEffect,
  OnChunkHook,
  OnThreadOpenHook,
  PromptFragment,
  SchemaTool,
  ToolDefinition,
  permitsEffect,
  readCommand,
  toToolEffect,
} from '@dltech/atlas-core'

import { CONTRIBUTES_NOTHING, definePlugin as defineRepoPlugin, type RepoPlugin } from './plugin'
import { ESidebarPlace, SURFACES_NOTHING } from './surface'

const DEFINED_BY_ATLAS = Symbol('atlas.definePlugin')

export const isDefinedByAtlas = (plugin: object): boolean => DEFINED_BY_ATLAS in plugin

const definePlugin = (plugin: RepoPlugin): RepoPlugin =>
  Object.defineProperty(defineRepoPlugin(plugin), DEFINED_BY_ATLAS, { value: true })

const fromCore = {
  AfterShellHook,
  AfterToolHook,
  AfterTurnHook,
  BeforeRequestHook,
  BeforeStepHook,
  BeforeToolHook,
  BeforeTurnHook,
  OnChunkHook,
  OnThreadOpenHook,
  EBeforeToolDecision,
  EDefinitionOrigin,
  EHookPhase,
  EReadConfidence,
  EStage,
  EToolEffect,
  PromptFragment,
  SchemaTool,
  ToolDefinition,
  permitsEffect,
  readCommand,
  toToolEffect,
}

const fromPlugin = { CONTRIBUTES_NOTHING, definePlugin }

const fromSurface = { ESidebarPlace, SURFACES_NOTHING }

export const atlasPluginApi = Object.freeze({ ...fromCore, ...fromPlugin, ...fromSurface })

export type PluginApiModule = {
  path: readonly string[]
  values: readonly string[]
  valueTypes: readonly string[]
  types: readonly string[]
}

const CORE_VALUE_TYPES = [
  'AfterShellHook',
  'AfterToolHook',
  'AfterTurnHook',
  'BeforeRequestHook',
  'BeforeStepHook',
  'BeforeToolHook',
  'BeforeTurnHook',
  'EBeforeToolDecision',
  'EDefinitionOrigin',
  'EHookPhase',
  'EReadConfidence',
  'EStage',
  'EToolEffect',
  'OnChunkHook',
  'OnThreadOpenHook',
  'PromptFragment',
  'SchemaTool',
  'ToolDefinition',
]

const CORE_TYPES = [
  'ActiveWorktree',
  'AfterShell',
  'AfterTool',
  'AfterTurn',
  'Assembled',
  'AssemblyTrace',
  'BeforeRequest',
  'BeforeStep',
  'BeforeTool',
  'BeforeToolOutcome',
  'BeforeTurn',
  'Chunk',
  'ClockPort',
  'CommandReading',
  'CommandSegment',
  'DeclaredPathField',
  'EndedShell',
  'Event',
  'EventDraft',
  'EventLogPort',
  'HookOrder',
  'HookOutcome',
  'IdPort',
  'ModelPart',
  'OnChunk',
  'OnThreadOpen',
  'PromptContext',
  'ProviderPrompt',
  'ThreadId',
  'ToolCall',
  'ToolInvocation',
  'ToolOutcome',
  'ToolRun',
  'WorkspacePort',
]

const PLUGIN_TYPES = ['PluginContribution', 'PluginHook', 'PluginHost', 'PortBinding', 'RepoPlugin']

const SURFACE_TYPES = ['PluginSurface', 'PluginSurfaceHook', 'SidebarSection', 'SidebarSectionRow']

export const PLUGIN_API_MODULES: readonly PluginApiModule[] = [
  {
    path: ['packages', 'core', 'src', 'index'],
    values: Object.keys(fromCore),
    valueTypes: CORE_VALUE_TYPES,
    types: CORE_TYPES,
  },
  {
    path: ['apps', 'tui', 'src', 'plugins', 'plugin'],
    values: Object.keys(fromPlugin),
    valueTypes: [],
    types: PLUGIN_TYPES,
  },
  {
    path: ['apps', 'tui', 'src', 'plugins', 'surface'],
    values: Object.keys(fromSurface),
    valueTypes: ['ESidebarPlace'],
    types: SURFACE_TYPES,
  },
]
