import type { ToolCall } from '../tool-runs'
import { EDetail, EToolClass, type Classification } from './kinds'
import { targetOf } from './reading'

export const awaitingApproval = (args: { call: ToolCall; cwd: string }): Classification => ({
  klass: EToolClass.Command,
  gather: null,
  line: `Waiting on you ${targetOf(args) ?? args.call.name}`.trim(),
  failed: false,
  note: 'approve?',
  metric: null,
  detail: args.call.note === null ? EDetail.None : EDetail.Reason,
})

export const denied = (args: { call: ToolCall; cwd: string }): Classification => ({
  klass: EToolClass.Command,
  gather: null,
  line: `Refused ${args.call.name} ${targetOf(args) ?? ''}`.trim(),
  failed: true,
  note: 'denied',
  metric: null,
  detail: args.call.note === null ? EDetail.None : EDetail.Reason,
})

/**
 * A call the tool itself refused to complete — not a command that exited non-zero.
 *
 * There is no output to classify, so every renderer would draw an empty panel. What the call has
 * instead is the sentence the model was handed, and that is the only thing worth opening onto.
 */
export const failed = (args: { call: ToolCall; cwd: string }): Classification => ({
  klass: EToolClass.Command,
  gather: null,
  line: `Failed ${args.call.name} ${targetOf(args) ?? ''}`.trim(),
  failed: true,
  note: 'failed',
  metric: null,
  detail: EDetail.Reason,
})
