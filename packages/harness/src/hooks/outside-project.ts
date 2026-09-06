import {
  AfterToolHook,
  EStage,
  EToolEffect,
  outsideProjectNotice,
  type AfterTool,
  type HookOrder,
} from '@dltech/atlas-core'

const declaredPath = (input: unknown): string | undefined => {
  if (typeof input !== 'object' || input === null || !('path' in input)) return undefined
  const path = input.path
  return typeof path === 'string' ? path : undefined
}

export class OutsideProjectHook extends AfterToolHook {
  readonly name = 'outside-project'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 1 }

  readonly run: AfterTool = async ({ call, result, projectDirectory }) => {
    if (!result.ok) return {}
    if (call.effect !== EToolEffect.Write) return {}

    const path = declaredPath(call.input)
    if (path === undefined) return {}

    const notice = outsideProjectNotice({ path, projectDirectory })
    if (notice === undefined) return {}

    return { additionalContext: notice }
  }
}
