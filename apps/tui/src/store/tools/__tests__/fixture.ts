import { toCallId } from '@dltech/atlas-core'

import { ECallState, type ToolCall } from '../../tool-runs'

let ordinal = 0

export function aCall(args: {
  name: string
  input?: unknown
  output?: unknown
  modelText?: string
  state?: ECallState
  note?: string | null
}): ToolCall {
  ordinal += 1

  return {
    callId: toCallId(`call-${ordinal}`),
    name: args.name,
    input: args.input ?? {},
    output: args.output,
    modelText: args.modelText ?? '',
    state: args.state ?? ECallState.Ok,
    note: args.note ?? null,
    at: null,
    settledAt: args.state === ECallState.Pending ? null : '2026-08-29T00:00:00.000Z',
  }
}

export const aShell = (args: {
  command: string
  description?: string
  stdout?: string
  exitCode?: number
}): ToolCall =>
  aCall({
    name: 'bash',
    input: {
      command: args.command,
      ...(args.description === undefined ? {} : { description: args.description }),
    },
    output: { command: args.command, stdout: args.stdout ?? '', exitCode: args.exitCode ?? 0 },
  })

export const CWD = '/repo'
