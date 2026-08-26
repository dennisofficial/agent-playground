export enum EStage {
  Guard = 'guard',
  Policy = 'policy',
  Observe = 'observe',
}

export type HookOrder = { stage: EStage; nudge: number }

const STAGE_PRECEDENCE: readonly EStage[] = [EStage.Guard, EStage.Policy, EStage.Observe]

export function orderHooks<T extends { name: string; order: HookOrder }>(
  hooks: readonly T[],
): readonly T[] {
  return [...hooks].sort((left, right) => {
    const byStage =
      STAGE_PRECEDENCE.indexOf(left.order.stage) - STAGE_PRECEDENCE.indexOf(right.order.stage)
    if (byStage !== 0) return byStage

    const byNudge = left.order.nudge - right.order.nudge
    if (byNudge !== 0) return byNudge

    if (left.name === right.name) return 0
    return left.name < right.name ? -1 : 1
  })
}
