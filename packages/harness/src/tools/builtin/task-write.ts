import {
  EToolEffect,
  PLAN_TASK_LIMIT,
  PLAN_TOOL_NAME,
  planInputSchema,
  planTasks,
  renderPlan,
  SchemaTool,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { injectable } from '../../container/injection'

const description = [
  'Write your plan down where the developer can see it: it renders as a checklist beside the conversation.',
  '',
  'Send the WHOLE plan every time. This call replaces the list rather than adding to it, so carry the tasks that are still standing and drop the ones that stopped mattering. Numbers follow position and are not yours to choose.',
  '',
  'Each task is one short imperative phrase, written for someone glancing at a narrow panel — not a paragraph, not a filename. Statuses are `pending`, `in_progress` and `completed`, and keeping them current is the point: mark a task `in_progress` when you start it and `completed` the moment it is done, in the same call you use to add what you learned.',
  '',
  'Give each task an `activeForm` too: the same task said as what you are doing rather than what you will do — `Fix the failing test` becomes `Fixing the failing test`. It is shown beneath the task while that task is in progress, so the panel reads as live work rather than a list. Send it on every task, not only the one you are starting.',
  '',
  `Ordinary work needs no plan. Reach for this when there are enough moving parts that the developer would otherwise have to ask what you are doing, and at most ${PLAN_TASK_LIMIT} tasks.`,
].join('\n')

@injectable()
export class TaskWriteTool extends SchemaTool<typeof planInputSchema> {
  readonly name = PLAN_TOOL_NAME
  readonly description = description
  readonly effect = EToolEffect.Read
  readonly inputSchema = planInputSchema
  override readonly isConcurrencySafe = (): boolean => true

  protected override async run({ input }: ToolRun<typeof planInputSchema>): Promise<ToolOutcome> {
    const tasks = planTasks(input.tasks)

    return { ok: true, output: { tasks }, modelText: renderPlan(tasks) }
  }
}
