import { quotedShellCommand, serviceEnding, serviceFailed, type ServiceEnding } from '@dltech/atlas-core'

export type ServiceEndedNotice = ServiceEnding & {
  serviceId: string
  command: string
  description?: string | undefined
}

type NamedService = { command: string; description?: string | undefined }

const named = (service: NamedService): string => {
  const description = service.description?.trim() ?? ''
  return description === '' ? quotedShellCommand(service.command) : `"${description}"`
}

export const serviceEndedLine = (ended: ServiceEndedNotice): string =>
  `Service ${ended.serviceId} ${named(ended)} ${serviceEnding(ended)}`

export const serviceEndingFailed = (ending: ServiceEnding): boolean => serviceFailed(ending)
