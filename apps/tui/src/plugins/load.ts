import {
  AfterShellHook,
  AfterToolHook,
  AfterTurnHook,
  BeforeRequestHook,
  BeforeStepHook,
  BeforeToolHook,
  BeforeTurnHook,
  EDefinitionOrigin,
  EHookPhase,
  type HookOrder,
  OnChunkHook,
  PromptFragment,
  ToolDefinition,
  resolveShadowing,
} from '@dltech/atlas-core'
import {
  portToken,
  registerDisposable,
  withinBudget,
  type DependencyContainer,
  type PortConstructor,
} from '@dltech/atlas-harness'

import {
  NativePlugin,
  type PluginContribution,
  type PluginHook,
  type PluginHost,
  type RepoPlugin,
} from './plugin'
import type { ContributedProjection } from './projection'
import type { ContributedSurface } from './surface'
import { validatePluginContribution } from './validate-contribution'

export type OriginatedPlugin =
  | { origin: EDefinitionOrigin.BuiltIn; plugin: NativePlugin }
  | { origin: EDefinitionOrigin.User; plugin: RepoPlugin }
  | { origin: EDefinitionOrigin.Project; plugin: RepoPlugin }

export type PluginRefusal = { id: string; origin: EDefinitionOrigin; reason: string }

export type PluginIdentity = { id: string; origin: EDefinitionOrigin }

export type LoadedPlugins = {
  loaded: readonly PluginIdentity[]
  shadowed: readonly PluginIdentity[]
  refused: readonly PluginRefusal[]
  projections: readonly ContributedProjection[]
  surfaces: readonly ContributedSurface[]
}

type RegisteredHookLike = { name: string; order: HookOrder; run: unknown }

const PHASE_TOKENS: Readonly<Record<EHookPhase, PortConstructor<RegisteredHookLike>>> = {
  [EHookPhase.BeforeTurn]: BeforeTurnHook,
  [EHookPhase.BeforeStep]: BeforeStepHook,
  [EHookPhase.BeforeRequest]: BeforeRequestHook,
  [EHookPhase.BeforeTool]: BeforeToolHook,
  [EHookPhase.AfterTool]: AfterToolHook,
  [EHookPhase.AfterShell]: AfterShellHook,
  [EHookPhase.OnChunk]: OnChunkHook,
  [EHookPhase.AfterTurn]: AfterTurnHook,
}

export const pluginLabel = (identity: PluginIdentity): string =>
  identity.origin === EDefinitionOrigin.BuiltIn ? identity.id : `${identity.origin}:${identity.id}`

export const namespacedHook = (args: { identity: PluginIdentity; hookName: string }): string =>
  `${pluginLabel(args.identity)}:${args.hookName}`

const REFUSED = Symbol('atlas.PluginRefused')

const identityOf = (entry: OriginatedPlugin): PluginIdentity => ({
  id: entry.plugin.id,
  origin: entry.origin,
})

/**
 * The host is a thunk because a native never receives one, and building it eagerly resolves ports a
 * native does not need. Those resolutions happen inside the budget, so a failure there would refuse
 * the plugin silently rather than surfacing as the wiring error it is.
 */
const contributionOf = (args: {
  entry: OriginatedPlugin
  host: () => PluginHost
}): Promise<unknown> =>
  args.entry.origin === EDefinitionOrigin.BuiltIn
    ? Promise.resolve(args.entry.plugin.contribute())
    : Promise.resolve(args.entry.plugin.register(args.host()))

function registerHook(args: {
  container: DependencyContainer
  identity: PluginIdentity
  hook: PluginHook
}): void {
  const { hook } = args
  const registered: RegisteredHookLike = {
    name: namespacedHook({ identity: args.identity, hookName: hook.name }),
    order: hook.order,
    run: hook.run,
  }
  args.container.register(portToken(PHASE_TOKENS[hook.phase]), { useValue: registered })
}

function registerContribution(args: {
  container: DependencyContainer
  identity: PluginIdentity
  contribution: PluginContribution
}): void {
  const { container, contribution } = args

  for (const hook of contribution.hooks ?? []) {
    registerHook({ container, identity: args.identity, hook })
  }
  for (const tool of contribution.tools ?? []) {
    container.register(portToken(ToolDefinition), { useValue: tool })
  }
  for (const binding of contribution.ports ?? []) {
    container.register(portToken(binding.token), { useValue: binding.use })
  }
  for (const fragment of contribution.promptFragments ?? []) {
    container.register(portToken(PromptFragment), { useValue: fragment })
  }

  const { dispose } = contribution
  if (dispose !== undefined) {
    registerDisposable({ container, close: async () => void (await dispose()) })
  }
}

/**
 * A native is a harness feature rather than one authoring of a name, so it is never shadowed: a
 * repo plugin sharing its id layers over it instead of replacing it, and every native contributes
 * before anything read off disk. That ordering is what makes a port binding overridable — tsyringe
 * hands a singular resolve the last registration — while the native's hooks and surfaces survive.
 */
export async function loadPlugins(args: {
  plugins: readonly OriginatedPlugin[]
  host: (identity: PluginIdentity) => PluginHost
  container: DependencyContainer
  budgetMs?: number | undefined
}): Promise<LoadedPlugins> {
  const winners = resolveShadowing({
    definitions: args.plugins,
    nameOf: (entry) => entry.plugin.id,
    unshadowable: EDefinitionOrigin.BuiltIn,
  })
  const survived = new Set(winners)

  const loaded: PluginIdentity[] = []
  const refused: PluginRefusal[] = []
  const projections: ContributedProjection[] = []
  const surfaces: ContributedSurface[] = []

  for (const entry of winners) {
    const identity = identityOf(entry)
    const label = pluginLabel(identity)
    const produced = await withinBudget<unknown>({
      label,
      run: () => contributionOf({ entry, host: () => args.host(identity) }),
      fallback: (mishap) => {
        refused.push({ ...identity, reason: `${mishap.kind}: ${mishap.detail}` })
        return REFUSED
      },
      budgetMs: args.budgetMs,
    })

    if (produced === REFUSED) continue

    const checked = validatePluginContribution({ contribution: produced, pluginId: label })
    if (!checked.ok) {
      refused.push({ ...identity, reason: `${checked.refusal}: ${checked.detail}` })
      continue
    }

    registerContribution({
      container: args.container,
      identity,
      contribution: checked.contribution,
    })
    for (const projection of checked.contribution.projections ?? []) {
      projections.push({ pluginId: label, projection })
    }
    for (const use of checked.contribution.surfaces ?? []) {
      surfaces.push({ pluginId: label, use })
    }
    loaded.push(identity)
  }

  return {
    loaded,
    shadowed: args.plugins.filter((entry) => !survived.has(entry)).map(identityOf),
    refused,
    projections,
    surfaces,
  }
}
