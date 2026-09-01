import { EDefinitionOrigin, EHookPhase, EStage } from '@dltech/atlas-core'

import { isDefinedByAtlas } from './api'
import type { PluginContribution, RepoPlugin } from './plugin'

export enum EPluginRefusal {
  Unreadable = 'unreadable',
  NoDefaultExport = 'no-default-export',
  NotAnObject = 'not-an-object',
  NotDefinedByAtlas = 'not-defined-by-atlas',
  IdNotAString = 'id-not-a-string',
  IdEmpty = 'id-empty',
  RegisterNotAFunction = 'register-not-a-function',
  DuplicateId = 'duplicate-id',
  ContributionNotAnObject = 'contribution-not-an-object',
  HooksNotAnArray = 'hooks-not-an-array',
  HookNotAnObject = 'hook-not-an-object',
  HookNameMissing = 'hook-name-missing',
  HookPhaseUnknown = 'hook-phase-unknown',
  HookOrderInvalid = 'hook-order-invalid',
  HookRunMissing = 'hook-run-missing',
}

export type RepoPluginOrigin = EDefinitionOrigin.User | EDefinitionOrigin.Project

export type RepoPluginRefusal = {
  refusal: EPluginRefusal
  id: string | undefined
  definedIn: string
  origin: RepoPluginOrigin
  detail: string
}

export type LoadedRepoPlugin = {
  plugin: RepoPlugin
  definedIn: string
  origin: RepoPluginOrigin
}

export type RepoPluginRead = {
  plugins: readonly LoadedRepoPlugin[]
  refusals: readonly RepoPluginRefusal[]
}

export type PluginValidation =
  | { ok: true; plugin: RepoPlugin }
  | { ok: false; refusal: EPluginRefusal; id: string | undefined; detail: string }

export type ContributionValidation =
  | { ok: true; contribution: PluginContribution }
  | { ok: false; refusal: EPluginRefusal; detail: string }

const HOOK_PHASES: readonly string[] = Object.values(EHookPhase)

const STAGES: readonly string[] = Object.values(EStage)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasPluginShape = (value: unknown): value is RepoPlugin =>
  isRecord(value) && typeof value['id'] === 'string' && typeof value['register'] === 'function'

const hasContributionShape = (value: unknown): value is PluginContribution => isRecord(value)

const refuse = (args: {
  refusal: EPluginRefusal
  id?: string
  detail: string
}): PluginValidation => ({
  ok: false,
  refusal: args.refusal,
  id: args.id,
  detail: args.detail,
})

export function validateRepoPlugin(module: unknown): PluginValidation {
  if (!isRecord(module)) {
    return refuse({
      refusal: EPluginRefusal.NotAnObject,
      detail: `the module evaluated to ${typeof module} rather than an object`,
    })
  }

  const exported = module['default']
  if (exported === undefined) {
    return refuse({
      refusal: EPluginRefusal.NoDefaultExport,
      detail: 'the module has no default export; a plugin is `export default definePlugin({...})`',
    })
  }

  if (!isRecord(exported)) {
    return refuse({
      refusal: EPluginRefusal.NotAnObject,
      detail: `the default export is ${typeof exported} rather than an object`,
    })
  }

  const id = exported['id']
  if (typeof id !== 'string') {
    return refuse({
      refusal: EPluginRefusal.IdNotAString,
      detail: `the default export has an id of type ${typeof id} rather than a string`,
    })
  }

  if (id.trim() === '') {
    return refuse({ refusal: EPluginRefusal.IdEmpty, detail: 'the default export has an empty id' })
  }

  if (typeof exported['register'] !== 'function') {
    return refuse({
      refusal: EPluginRefusal.RegisterNotAFunction,
      id,
      detail: `${id} has a register of type ${typeof exported['register']} rather than a function`,
    })
  }

  if (!isDefinedByAtlas(exported)) {
    return refuse({
      refusal: EPluginRefusal.NotDefinedByAtlas,
      id,
      detail:
        `${id} was not produced by definePlugin from 'atlas' — either call it, or a node_modules ` +
        'under the plugin directory shadowed the atlas module and handed it a second copy',
    })
  }

  if (!hasPluginShape(exported)) {
    return refuse({
      refusal: EPluginRefusal.NotAnObject,
      id,
      detail: `${id} is not shaped like a plugin`,
    })
  }

  return { ok: true, plugin: exported }
}

export function refuseDuplicateIds(loaded: readonly LoadedRepoPlugin[]): RepoPluginRead {
  const kept: LoadedRepoPlugin[] = []
  const refusals: RepoPluginRefusal[] = []
  const seen = new Map<string, string>()

  for (const entry of loaded) {
    const claimed = seen.get(entry.plugin.id)
    if (claimed === undefined) {
      seen.set(entry.plugin.id, entry.definedIn)
      kept.push(entry)
      continue
    }

    refusals.push({
      refusal: EPluginRefusal.DuplicateId,
      id: entry.plugin.id,
      definedIn: entry.definedIn,
      origin: entry.origin,
      detail: `${entry.plugin.id} is already defined by ${claimed}`,
    })
  }

  return { plugins: kept, refusals }
}

const validateHook = (args: {
  hook: unknown
  pluginId: string
}): { refusal: EPluginRefusal; detail: string } | undefined => {
  if (!isRecord(args.hook)) {
    return {
      refusal: EPluginRefusal.HookNotAnObject,
      detail: `${args.pluginId} contributed a hook of type ${typeof args.hook}`,
    }
  }

  const name = args.hook['name']
  if (typeof name !== 'string' || name.trim() === '') {
    return {
      refusal: EPluginRefusal.HookNameMissing,
      detail: `${args.pluginId} contributed a hook without a name`,
    }
  }

  const phase = args.hook['phase']
  if (typeof phase !== 'string' || !HOOK_PHASES.includes(phase)) {
    return {
      refusal: EPluginRefusal.HookPhaseUnknown,
      detail: `${args.pluginId}:${name} names the unknown phase ${String(phase)}; known phases are ${HOOK_PHASES.join(', ')}`,
    }
  }

  const order = args.hook['order']
  if (
    !isRecord(order) ||
    typeof order['stage'] !== 'string' ||
    !STAGES.includes(order['stage']) ||
    typeof order['nudge'] !== 'number'
  ) {
    return {
      refusal: EPluginRefusal.HookOrderInvalid,
      detail: `${args.pluginId}:${name} needs an order of { stage, nudge }; stages are ${STAGES.join(', ')}`,
    }
  }

  if (typeof args.hook['run'] !== 'function') {
    return {
      refusal: EPluginRefusal.HookRunMissing,
      detail: `${args.pluginId}:${name} has a run of type ${typeof args.hook['run']} rather than a function`,
    }
  }

  return undefined
}

export function validatePluginContribution(args: {
  contribution: unknown
  pluginId: string
}): ContributionValidation {
  if (!isRecord(args.contribution)) {
    return {
      ok: false,
      refusal: EPluginRefusal.ContributionNotAnObject,
      detail: `${args.pluginId} register returned ${typeof args.contribution} rather than an object`,
    }
  }

  const hooks = args.contribution['hooks']
  if (hooks !== undefined) {
    if (!Array.isArray(hooks)) {
      return {
        ok: false,
        refusal: EPluginRefusal.HooksNotAnArray,
        detail: `${args.pluginId} contributed hooks of type ${typeof hooks} rather than an array`,
      }
    }

    for (const hook of hooks) {
      const failed = validateHook({ hook, pluginId: args.pluginId })
      if (failed !== undefined) return { ok: false, ...failed }
    }
  }

  if (!hasContributionShape(args.contribution)) {
    return {
      ok: false,
      refusal: EPluginRefusal.ContributionNotAnObject,
      detail: `${args.pluginId} returned something that is not a contribution`,
    }
  }

  return { ok: true, contribution: args.contribution }
}
