import {
  AfterToolHook,
  EStage,
  PLAN_TOOL_NAME,
  planInputSchema,
  planReminder,
  planTasks,
  type AfterTool,
  type HookOrder,
} from '@dltech/atlas-core'


export class MirrorPlanHook extends AfterToolHook {
  readonly name = 'plan'
  readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }

  readonly run: AfterTool = async ({ call, result }) => {
    if (call.name !== PLAN_TOOL_NAME || !result.ok) return {}

    const parsed = planInputSchema.safeParse(call.input)
    if (!parsed.success) return {}

    return { additionalContext: planReminder(planTasks(parsed.data.tasks)) }
  }
}
