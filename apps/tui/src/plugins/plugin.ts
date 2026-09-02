import type {
  AfterShell,
  AfterTool,
  AfterTurn,
  BeforeRequest,
  BeforeStep,
  BeforeTool,
  BeforeTurn,
  ClockPort,
  EDefinitionOrigin,
  EHookPhase,
  EventLogPort,
  HookOrder,
  IdPort,
  OnChunk,
  PromptFragment,
  ToolDefinition,
  WorkspacePort,
} from '@dltech/atlas-core'

import type { PluginProjection } from './projection'
import type { PluginSurfaceHook } from './surface'

type Phase<TKind extends EHookPhase, TRun> = {
  phase: TKind
  name: string
  order: HookOrder
  run: TRun
}

export type PluginHook =
  | Phase<EHookPhase.BeforeTurn, BeforeTurn>
  | Phase<EHookPhase.BeforeStep, BeforeStep>
  | Phase<EHookPhase.BeforeRequest, BeforeRequest>
  | Phase<EHookPhase.BeforeTool, BeforeTool>
  | Phase<EHookPhase.AfterTool, AfterTool>
  | Phase<EHookPhase.AfterShell, AfterShell>
  | Phase<EHookPhase.OnChunk, OnChunk>
  | Phase<EHookPhase.AfterTurn, AfterTurn>

export type PortBinding<TPort = unknown> = {
  token: abstract new (...args: never[]) => TPort
  use: TPort
}

export type PluginContribution = {
  hooks?: readonly PluginHook[]
  tools?: readonly ToolDefinition[]
  ports?: readonly PortBinding[]
  promptFragments?: readonly PromptFragment[]
  projections?: readonly PluginProjection<unknown>[]
  surfaces?: readonly PluginSurfaceHook[]
  dispose?: () => void | Promise<void>
}

export const CONTRIBUTES_NOTHING: PluginContribution = Object.freeze({})

/**
 * A repo plugin is handed this and nothing else — no container. Vocabulary reaches it through the
 * `'atlas'` virtual module rather than through a field here, so this stays the set of values that
 * cannot be module-level: the ones scoped to one plugin in one session.
 */
export type PluginHost = {
  readonly id: string
  readonly origin: EDefinitionOrigin
  readonly projectDirectory: string
  readonly atlasHome: string
  readonly log: EventLogPort
  readonly workspace: WorkspacePort
  readonly clock: ClockPort
  readonly ids: IdPort
}

/**
 * Natives are resolved out of the container and repo plugins are imported off disk, so the two
 * tiers share a return type rather than an entry shape. `abstract class` because the token is the
 * contract.
 */
export abstract class NativePlugin {
  abstract readonly id: string
  abstract contribute(): PluginContribution | Promise<PluginContribution>
}

export type RepoPlugin = {
  id: string
  register: (host: PluginHost) => PluginContribution | Promise<PluginContribution>
}

export const definePlugin = (plugin: RepoPlugin): RepoPlugin => plugin
