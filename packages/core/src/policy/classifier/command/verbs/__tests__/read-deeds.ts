import { toCallId, toThreadId } from '../../../../../events/ids'
import { EToolEffect, type ToolCall } from '../../../../../tools/tool'
import { readCommand } from '../../read-command'
import { deedsOf, EPathDeclaration } from '../../../deed-of'
import type { Deed, EDeed } from '../../../deed'

export const PROJECT = '/proj'

const bashCall = ({ command }: { command: string }): ToolCall => ({
  callId: toCallId('call-1'),
  name: 'bash',
  input: { command },
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread-1'),
})

export function deedsFor({
  command,
  workdir,
}: {
  command: string
  workdir?: string | undefined
}): readonly Deed[] {
  return deedsOf({
    call: bashCall({ command }),
    declaration: { kind: EPathDeclaration.Declared, fields: [] },
    reading: readCommand({ command, workdir, projectDirectory: PROJECT }),
    projectDirectory: PROJECT,
  })
}

export function actionsFor({
  command,
  workdir,
}: {
  command: string
  workdir?: string | undefined
}): readonly EDeed[] {
  return deedsFor({ command, workdir }).map((deed) => deed.action)
}

export function oneDeed({
  command,
  workdir,
}: {
  command: string
  workdir?: string | undefined
}): Deed {
  const deeds = deedsFor({ command, workdir })
  const only = deeds[0]
  if (only === undefined || deeds.length !== 1) {
    throw new Error(`expected exactly one deed for "${command}", got ${deeds.length}`)
  }
  return only
}

export function targetValues({ deed }: { deed: Deed }): readonly string[] {
  return deed.targets.map((target) => target.value)
}
