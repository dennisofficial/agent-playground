import { z } from 'zod'

import {
  EServiceStatus,
  EToolEffect,
  quotedShellCommand,
  SchemaTool,
  serviceEnding,
  TAKES_NO_PATHS,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { ServiceRegistryPort, type ServiceSnapshot } from '../../services'

const inputSchema = z.strictObject({
  runningOnly: z.boolean().optional(),
})

const description = [
  'List the services running in this session, whoever started them.',
  'Set runningOnly to leave out the ones that have already exited.',
  'Each entry names its id, its command, whether it is still running, and where its log is.',
  'Do not poll this to watch a service: if one dies you will be told, and its log file says what it is doing.',
].join(' ')

function lineFor(snapshot: ServiceSnapshot): string {
  const state = snapshot.status === EServiceStatus.Running ? 'running' : serviceEnding(snapshot)
  return `${snapshot.serviceId}  ${quotedShellCommand(snapshot.command)}  ${state}\n    log: ${snapshot.logPath}`
}

export class ServiceListTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'service_list'
  readonly description = description
  readonly effect = EToolEffect.Read
  override readonly isConcurrencySafe = (): boolean => true

  readonly inputSchema = inputSchema
  override readonly pathFields = TAKES_NO_PATHS

  constructor(private readonly services: ServiceRegistryPort) {
    super()
  }

  protected override async run({
    input,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const all = this.services.list()
    const shown =
      input.runningOnly === true
        ? all.filter((one) => one.status === EServiceStatus.Running)
        : all

    if (shown.length === 0) {
      return {
        ok: true,
        output: { services: [] },
        modelText:
          input.runningOnly === true
            ? 'No service is running.'
            : 'No service is registered. service_start is what puts one here.',
      }
    }

    return {
      ok: true,
      output: {
        services: shown.map((snapshot) => ({
          serviceId: snapshot.serviceId,
          command: snapshot.command,
          description: snapshot.description,
          status: snapshot.status,
          exitCode: snapshot.exitCode,
          pid: snapshot.pid,
          logPath: snapshot.logPath,
          startedAt: snapshot.startedAt,
        })),
      },
      modelText: shown.map(lineFor).join('\n'),
    }
  }
}
