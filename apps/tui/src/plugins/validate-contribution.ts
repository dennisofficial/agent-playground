import { EHookPhase, EStage } from '@dltech/atlas-core'

import type { PluginContribution } from './plugin'
import { EPluginRefusal, isRecord, type ContributionValidation } from './validate'

const HOOK_PHASES: readonly string[] = Object.values(EHookPhase)

const STAGES: readonly string[] = Object.values(EStage)

const hasContributionShape = (value: unknown): value is PluginContribution => isRecord(value)

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

const validateProjection = (args: {
  projection: unknown
  pluginId: string
}): { refusal: EPluginRefusal; detail: string } | undefined => {
  if (!isRecord(args.projection)) {
    return {
      refusal: EPluginRefusal.ProjectionNotAnObject,
      detail: `${args.pluginId} contributed a projection of type ${typeof args.projection}`,
    }
  }

  const id = args.projection['id']
  if (typeof id !== 'string' || id.trim() === '') {
    return {
      refusal: EPluginRefusal.ProjectionIdMissing,
      detail: `${args.pluginId} contributed a projection without an id`,
    }
  }

  for (const member of ['publish', 'current', 'subscribe', 'version']) {
    if (typeof args.projection[member] !== 'function') {
      return {
        refusal: EPluginRefusal.ProjectionCannotFold,
        detail: `${args.pluginId}:${id} has a ${member} of type ${typeof args.projection[member]} rather than a function; build one with defineProjection`,
      }
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

  const projections = args.contribution['projections']
  if (projections !== undefined) {
    if (!Array.isArray(projections)) {
      return {
        ok: false,
        refusal: EPluginRefusal.ProjectionsNotAnArray,
        detail: `${args.pluginId} contributed projections of type ${typeof projections} rather than an array`,
      }
    }

    for (const projection of projections) {
      const failed = validateProjection({ projection, pluginId: args.pluginId })
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
