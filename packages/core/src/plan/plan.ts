import { z } from 'zod'

export enum EPlanStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Completed = 'completed',
}

export const PLAN_TOOL_NAME = 'task_write'

export const PLAN_TASK_LIMIT = 40

export const PLAN_TEXT_LIMIT = 120

const taskTextSchema = z.string().min(1).max(PLAN_TEXT_LIMIT)

export const planInputSchema = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        text: taskTextSchema,
        activeForm: taskTextSchema.optional(),
        status: z.enum(EPlanStatus).default(EPlanStatus.Pending),
      }),
    )
    .max(PLAN_TASK_LIMIT),
})

export type PlanInput = z.output<typeof planInputSchema>

export type WrittenTask = PlanInput['tasks'][number]

export type PlanTask = {
  ordinal: number
  text: string
  status: EPlanStatus
  activeForm?: string | undefined
}

export const NO_PLAN = 'No plan yet.'

export function planTasks(written: readonly WrittenTask[]): readonly PlanTask[] {
  return written.map((task, index) => ({
    ordinal: index + 1,
    text: task.text,
    status: task.status,
    ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
  }))
}

const lineOf = (task: PlanTask): string => {
  const named = `#${task.ordinal} [${task.status}] ${task.text}`
  return task.activeForm === undefined ? named : `${named} (active: ${task.activeForm})`
}

export function renderPlan(tasks: readonly PlanTask[]): string {
  if (tasks.length === 0) return NO_PLAN

  return tasks.map(lineOf).join('\n')
}

const PLAN_PREFACE = 'Your plan, as you last wrote it with task_write:'

const PLAN_CLEARED = 'You have no plan written. Call task_write if the work needs one.'

export function planReminder(tasks: readonly PlanTask[]): string {
  if (tasks.length === 0) return PLAN_CLEARED

  return `${PLAN_PREFACE}\n\n${renderPlan(tasks)}`
}
