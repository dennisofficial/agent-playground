import { stat } from 'node:fs/promises'

import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EServiceStatus,
  EToolEffect,
  SchemaTool,
  serviceEnding,
  type DeclaredPathField,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { logTail, ServiceRegistryPort } from '../../services'

const inputSchema = z.strictObject({
  command: z.string().min(1),
  description: z.string().min(1),
  workdir: z.string().min(1).optional(),
})

const START_TAIL_CHARACTERS = 2_000

const description = [
  'Start a long-running service - a dev server, a watcher, anything that should stay up while you keep working - and get its id back at once.',
  'This is not for work you are waiting on: a command that ends and whose result you need belongs on bash, backgrounded or not.',
  'A service never times out and never holds the turn open; if it dies you will be told, wherever you are.',
  'Its stdout and stderr go to one log file, named in the reply; read or grep that file to check on it, and stop it with service_stop.',
  'In bash, pipe the log through the atlas-svc helper: `atlas-svc logs svc_1 | grep ...` resolves the id to its log and execs tail, so -n and -f pass straight through into whatever pipe you build.',
  'Its stdin is closed and it is its own process group, so nothing it forks outlives a stop.',
].join(' ')

export class ServiceStartTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'service_start'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema
  override readonly pathFields: readonly DeclaredPathField[] = [
    {
      field: 'workdir',
      presence: EPathPresence.Optional,
      form: EPathForm.Absolute,
      content: EContentAccess.None,
    },
  ]

  constructor(private readonly services: ServiceRegistryPort) {
    super()
  }

  protected override async run({
    input,
    projectDirectory,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const cwd = input.workdir ?? projectDirectory

    if (input.workdir !== undefined) {
      const directory = await stat(input.workdir).catch(() => undefined)
      if (directory === undefined) {
        return { ok: false, reason: `workdir ${input.workdir} does not exist, so there is nowhere to run the service` }
      }
      if (!directory.isDirectory()) {
        return { ok: false, reason: `workdir ${input.workdir} is a file, not a directory` }
      }
    }

    const started = await this.services.start({
      threadId,
      command: input.command,
      description: input.description,
      cwd,
    })
    if (!started.ok) return started

    const { snapshot } = started

    if (snapshot.status !== EServiceStatus.Running) {
      const tail = logTail({ path: snapshot.logPath, characters: START_TAIL_CHARACTERS }).trimEnd()
      return {
        ok: false,
        reason: [
          `Service ${snapshot.serviceId} ${serviceEnding(snapshot)} before it had settled, so it is not running.`,
          tail === '' ? 'Its log is empty.' : `Its log:\n${tail}`,
        ].join('\n\n'),
      }
    }

    return {
      ok: true,
      output: {
        serviceId: snapshot.serviceId,
        command: snapshot.command,
        description: snapshot.description,
        status: snapshot.status,
        pid: snapshot.pid,
        logPath: snapshot.logPath,
      },
      modelText: [
        `Started ${snapshot.serviceId} (pid ${snapshot.pid}) - ${snapshot.description}.`,
        `log: ${snapshot.logPath}`,
        'It keeps running after this turn ends and nobody waits on it; if it dies you will be told.',
        `Read the log with the file tools you already have, or pipe it in bash: atlas-svc logs ${snapshot.serviceId} | grep ...`,
        `Stop it with service_stop({ id: "${snapshot.serviceId}" }).`,
      ].join('\n'),
    }
  }
}
