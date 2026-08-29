import type { Event } from '../events/envelope'
import { eventsOfType, inputForCall } from '../events/projections'
import { PLAN_TOOL_NAME, planInputSchema, planTasks, type PlanTask } from './plan'

const NO_TASKS: readonly PlanTask[] = Object.freeze([])

export function planFromEvents(events: readonly Event[]): readonly PlanTask[] {
  const succeeded = new Set(
    eventsOfType({ events, type: 'tool-result' })
      .filter((event) => event.error === undefined)
      .map((event) => event.callId),
  )

  const written = eventsOfType({ events, type: 'tool-called' }).filter(
    (event) => event.name === PLAN_TOOL_NAME && succeeded.has(event.callId),
  )

  for (const call of [...written].reverse()) {
    const parsed = planInputSchema.safeParse(inputForCall({ events, callId: call.callId }))
    if (parsed.success) return planTasks(parsed.data.tasks)
  }

  return NO_TASKS
}
