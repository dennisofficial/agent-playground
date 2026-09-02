import { EDefinitionOrigin } from '@dltech/atlas-core'

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
  ProjectionsNotAnArray = 'projections-not-an-array',
  ProjectionNotAnObject = 'projection-not-an-object',
  ProjectionIdMissing = 'projection-id-missing',
  ProjectionCannotFold = 'projection-cannot-fold',
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasPluginShape = (value: unknown): value is RepoPlugin =>
  isRecord(value) && typeof value['id'] === 'string' && typeof value['register'] === 'function'

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
