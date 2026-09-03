import { wrapInSystemReminder } from '../../context/render'
import { shellLabel } from '../../shells/label'
import { defineRule, type Rule } from '../rule'
import { appendedAtTail } from './tail-block'

export type RunningService = {
  serviceId: string
  command: string
  description?: string | undefined
  logPath: string
}

export type RunningServicesSource = () => readonly RunningService[]

const lineFor = (service: RunningService): string =>
  `${service.serviceId}  ${shellLabel(service)}  log: ${service.logPath}`

export function runningServicesReminder(services: readonly RunningService[]): string {
  return wrapInSystemReminder(
    [
      'These services are running:',
      services.map(lineFor).join('\n'),
      'They are infrastructure you work against, not work you are waiting on: no completion is coming, and if one dies you will be told. Health-check one by reading its log file (or piping it: `atlas-svc logs <id> | grep ...`) or hitting its endpoint, never by polling service_list. service_stop({ id }) stops one.',
    ].join('\n\n'),
  )
}

export function runningServicesBlock({
  runningServices,
}: {
  runningServices: RunningServicesSource
}): Rule {
  return defineRule({
    name: 'runningServicesBlock',
    apply: (input, ctx) => {
      const services = runningServices()
      if (services.length === 0) return input

      return appendedAtTail({ input, ctx, text: runningServicesReminder(services) })
    },
  })
}
