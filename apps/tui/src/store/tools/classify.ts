/**
 * The registry: every tool call, read once, before anything groups it.
 *
 * Grouping, phrasing, the right-hand measure and the expanded renderer all read from ONE
 * classification, so a tool that wants a different treatment is a single entry here rather than an
 * edit in four files that will disagree the first time somebody touches one.
 */

import { ECallState, type ToolCall } from '../tool-runs'
import { readShell } from './bash'
import { EDetail, EGather, EToolClass, type Classification } from './kinds'
import {
  commandLabel,
  count,
  detailOf,
  diffStatOf,
  inputOf,
  num,
  outputOf,
  plural,
  records,
  relativise,
  str,
  strings,
  targetOf,
} from './reading'

const MCP_SEPARATOR = '__'

const pending = (args: { call: ToolCall; cwd: string }): Classification => ({
  klass: EToolClass.Gathered,
  gather: EGather.Run,
  line: targetOf(args) ?? args.call.name,
  failed: false,
  note: '',
  metric: null,
  detail: EDetail.None,
})

const denied = (args: { call: ToolCall; cwd: string }): Classification => ({
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
 * There is no output to classify, so every renderer below would draw an empty panel. What the call
 * has instead is the sentence the model was handed, and that is the only thing worth opening onto.
 */
const failed = (args: { call: ToolCall; cwd: string }): Classification => ({
  klass: EToolClass.Command,
  gather: null,
  line: `Failed ${args.call.name} ${targetOf(args) ?? ''}`.trim(),
  failed: true,
  note: 'failed',
  metric: null,
  detail: EDetail.Reason,
})

/** A patch when the tool sent one, and the counts it reported when it did not. */
function statOf(call: ToolCall): { added: number; removed: number } | null {
  const patch = diffStatOf(call)
  if (patch !== null) return patch

  const output = outputOf(call)
  const added = num(output.added)
  const removed = num(output.removed)
  if (added === undefined && removed === undefined) return null
  return { added: added ?? 0, removed: removed ?? 0 }
}

function changed(args: { call: ToolCall; cwd: string }): Classification {
  const output = outputOf(args.call)
  const path = relativise(str(output.path) ?? targetOf(args) ?? args.call.name, args.cwd)
  const stat = statOf(args.call)
  const detail = diffStatOf(args.call) === null ? EDetail.None : EDetail.Diff

  if (args.call.name === 'write') {
    const created = output.created === true
    // A write sends no patch, but the CONTENT is on the call — so a created file still has something
    // to show, in the panel an edit's diff would have taken.
    const wrote = str(inputOf(args.call).content) !== undefined
    return {
      klass: EToolClass.Change,
      gather: null,
      line: `${created ? 'Created' : 'Wrote'} ${path}`,
      failed: false,
      note: created ? 'new' : `${count(num(output.bytes) ?? 0)} B`,
      metric: null,
      detail: detail === EDetail.Diff ? detail : wrote ? EDetail.Created : EDetail.None,
    }
  }

  return {
    klass: EToolClass.Change,
    gather: null,
    line: `Edited ${path}`,
    failed: false,
    note: stat === null ? 'edited' : `+${stat.added} −${stat.removed}`,
    metric: null,
    detail,
  }
}

const lineCount = (text: string): number => (text.length === 0 ? 0 : text.split('\n').length)

/**
 * The sentence form, when there is something to put in it.
 *
 * `Read read` is what a fabricated one looks like: a call with no target has nothing for the verb to
 * take, and prefixing the tool's own name with a verb reads as a stutter. Better to fall back to the
 * bare label than to invent a sentence about nothing.
 */
const standing = (args: { verb: string; target: string | undefined }): { alone?: string } =>
  args.target === undefined ? {} : { alone: `${args.verb} ${args.target}` }

function gatheredByName(args: { call: ToolCall; cwd: string }): Classification | null {
  const { call } = args
  const output = outputOf(call)
  const found = targetOf(args)
  const target = found ?? call.name

  if (call.name === 'read') {
    const path = relativise(target, args.cwd)
    const lines = num(output.lines) ?? lineCount(call.modelText)
    return {
      klass: EToolClass.Gathered,
      gather: EGather.Read,
      line: path,
      ...standing({ verb: 'Read', target: found === undefined ? undefined : path }),
      failed: false,
      note: `${count(lines)} l`,
      metric: lines,
      detail: EDetail.File,
    }
  }

  if (call.name === 'grep') {
    const matches = strings(output.matches).length
    return {
      klass: EToolClass.Gathered,
      gather: EGather.Search,
      line: target,
      ...standing({ verb: 'Searched for', target: found }),
      failed: false,
      note: plural(matches, 'match', 'matches'),
      metric: matches,
      detail: EDetail.Matches,
    }
  }

  if (call.name === 'glob') {
    const paths = strings(output.paths).length
    return {
      klass: EToolClass.Gathered,
      gather: EGather.List,
      line: target,
      ...standing({ verb: 'Matched', target: found }),
      failed: false,
      note: plural(paths, 'path'),
      metric: null,
      detail: EDetail.Paths,
    }
  }

  if (call.name === 'shell_output' || call.name === 'shell_list') {
    const quiet = detailOf(call).join('').trim().length === 0
    return {
      klass: EToolClass.Gathered,
      gather: EGather.Watch,
      line: target,
      ...standing({ verb: 'Checked', target: found }),
      failed: false,
      note: quiet ? 'quiet' : `${count(lineCount(str(output.text) ?? ''))} l`,
      metric: null,
      detail: EDetail.Output,
    }
  }

  return null
}

export function classify(args: { call: ToolCall; cwd: string }): Classification {
  const { call } = args
  if (call.state === ECallState.Denied) return denied(args)
  if (call.state === ECallState.Pending) return pending(args)
  if (call.state === ECallState.Failed && call.note !== null) return failed(args)

  if (call.name.includes(MCP_SEPARATOR)) {
    return {
      klass: EToolClass.External,
      gather: null,
      line: `Called ${call.name.split(MCP_SEPARATOR).at(-1) ?? call.name}`,
      failed: call.state !== ECallState.Ok,
      note: call.state === ECallState.Ok ? 'done' : 'failed',
      metric: null,
      detail: EDetail.Output,
    }
  }

  if (call.name === 'edit' || call.name === 'write') return changed(args)

  if (call.name === 'bash') {
    const output = outputOf(call)
    const exitCode = num(output.exitCode) ?? null
    return readShell({
      command: str(output.command) ?? str(inputOf(call).command) ?? commandLabel(call),
      description: str(inputOf(call).description) ?? '',
      stdout: str(output.stdout) ?? '',
      exitCode,
      ok: call.state === ECallState.Ok && (exitCode ?? 0) === 0,
    })
  }

  const byName = gatheredByName(args)
  if (byName !== null) return byName

  if (call.name === 'shell_kill') {
    return {
      klass: EToolClass.Command,
      gather: null,
      line: `Killed ${targetOf(args) ?? 'a shell'}`,
      failed: call.state !== ECallState.Ok,
      note: call.state === ECallState.Ok ? 'killed' : 'failed',
      metric: null,
      detail: EDetail.None,
    }
  }

  if (call.name === 'task_write') {
    return {
      klass: EToolClass.Plan,
      gather: null,
      line: 'Updated the plan',
      failed: false,
      note: plural(records(outputOf(call).tasks).length, 'task'),
      metric: null,
      detail: EDetail.Plan,
    }
  }

  return {
    klass: EToolClass.External,
    gather: null,
    line: `Called ${call.name}`,
    failed: call.state !== ECallState.Ok,
    note: call.state === ECallState.Ok ? 'done' : 'failed',
    metric: null,
    detail: detailOf(call).length > 0 ? EDetail.Output : EDetail.None,
  }
}
