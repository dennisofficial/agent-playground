import { EContextSlot, type CallId, type Event, type EventOfType } from '@dltech/atlas-core'

export enum ECallState {
  Pending = 'pending',
  AwaitingApproval = 'awaiting-approval',
  Ok = 'ok',
  Failed = 'failed',
  Denied = 'denied',
}

/**
 * One call, with the tool's OUTPUT still attached.
 *
 * The previous model dropped it at this boundary and kept a handful of derived totals instead, which
 * meant a transcript could never say what a call actually did — only how many of them there were.
 * Everything downstream of here reads the output: what the call is called, what it counts, and which
 * renderer it opens into.
 */
export type ToolCall = {
  callId: CallId
  name: string
  input: unknown
  output: unknown
  modelText: string
  state: ECallState
  /** The error or denial reason, when there is one. */
  note: string | null
  at: string | null
  settledAt: string | null
  /**
   * What a still-running call has printed so far, pushed live from the tool rather than read off
   * the result. Absent once the call settles — the durable output takes over.
   */
  liveOutput?: string | undefined
  attachments: readonly ContextAttachment[]
}

export type ContextAttachment = {
  id: string
  slot: string
  name: string
  content: string
}

/**
 * A maximal stretch of adjacent calls, in the order they were made.
 *
 * Not grouped by verb, and not grouped at all: grouping is a decision about meaning that belongs to
 * `tools/aggregate`, which reads a classification this layer knows nothing about. What the store
 * owes the renderer is the run and its order.
 */
export type ToolRun = {
  key: string
  openedBy: CallId
  calls: readonly ToolCall[]
}

export type LiveToolCall = {
  callId: CallId
  name: string
  input: unknown
  precededByBlocks: number
}

export type LiveToolRun = { run: ToolRun; precededByBlocks: number }

const OPEN: readonly ECallState[] = [ECallState.Pending, ECallState.AwaitingApproval]

export const settled = (call: ToolCall): boolean => !OPEN.includes(call.state)

export const succeeded = (call: ToolCall): boolean =>
  call.state === ECallState.Ok || OPEN.includes(call.state)

type Settle = { at: string; state: ECallState; output: unknown; modelText: string; note: string | null }

function awaitingApprovalIn(events: readonly Event[]): ReadonlyMap<CallId, string> {
  const asked = new Map<CallId, string>()

  for (const event of events) {
    if (event.type === 'approval-requested') asked.set(event.callId, event.reason)
    if (event.type === 'approval-answered') asked.delete(event.callId)
  }

  return asked
}

function settlesOf(events: readonly Event[]): Map<CallId, Settle> {
  const settles = new Map<CallId, Settle>()

  for (const event of events) {
    if (event.type === 'tool-result') {
      settles.set(event.callId, {
        at: event.at,
        state: event.error === undefined ? ECallState.Ok : ECallState.Failed,
        output: event.output,
        modelText: event.modelText ?? '',
        note: event.error?.message ?? null,
      })
    }

    if (event.type === 'tool-denied') {
      settles.set(event.callId, {
        at: event.at,
        state: ECallState.Denied,
        output: undefined,
        modelText: '',
        note: event.reason,
      })
    }
  }

  return settles
}

type CallSeed = { callId: CallId; name: string; input: unknown; at: string | null }

const seedOf = (event: EventOfType<'tool-called'>): CallSeed => ({
  callId: event.callId,
  name: event.name,
  input: event.input,
  at: event.at,
})

function callOf(args: {
  seed: CallSeed
  settle: Settle | undefined
  awaiting: string | undefined
  attachments: readonly ContextAttachment[]
}): ToolCall {
  const { seed, settle, awaiting } = args
  const unsettled = awaiting === undefined ? ECallState.Pending : ECallState.AwaitingApproval

  return {
    callId: seed.callId,
    name: seed.name,
    input: seed.input,
    output: settle?.output,
    modelText: settle?.modelText ?? '',
    state: settle?.state ?? unsettled,
    note: settle?.note ?? awaiting ?? null,
    at: seed.at,
    settledAt: settle?.at ?? null,
    attachments: args.attachments,
  }
}

function runOf(args: {
  seeds: readonly CallSeed[]
  settles: ReadonlyMap<CallId, Settle>
  awaiting: ReadonlyMap<CallId, string>
  attachments: ReadonlyMap<CallId, readonly ContextAttachment[]>
}): ToolRun {
  const first = args.seeds[0]
  if (first === undefined) throw new Error('a tool run needs at least one call')

  return {
    key: `tools:${first.callId}`,
    openedBy: first.callId,
    calls: args.seeds.map((seed) =>
      callOf({
        seed,
        settle: args.settles.get(seed.callId),
        awaiting: args.awaiting.get(seed.callId),
        attachments: args.attachments.get(seed.callId) ?? NOTHING_ATTACHED,
      }),
    ),
  }
}

const NOTHING_ATTACHED: readonly ContextAttachment[] = Object.freeze([])

const MESSAGE_BADGES: ReadonlySet<string> = new Set([EContextSlot.Skill, EContextSlot.File])

function attachmentsOf(events: readonly Event[]): Map<CallId, ContextAttachment[]> {
  const attached = new Map<CallId, ContextAttachment[]>()
  let lastCall: CallId | null = null

  for (const event of events) {
    if (brokenBy(event)) {
      lastCall = null
      continue
    }
    if (event.type === 'tool-called' || event.type === 'tool-result' || event.type === 'tool-denied') {
      lastCall = event.callId
      continue
    }
    if (event.type !== 'context-loaded' || lastCall === null || MESSAGE_BADGES.has(event.slot)) {
      continue
    }

    const attachment: ContextAttachment = {
      id: event.id,
      slot: event.slot,
      name: event.key,
      content: event.content,
    }
    const held = attached.get(lastCall)
    if (held === undefined) attached.set(lastCall, [attachment])
    else held.push(attachment)
  }

  return attached
}

/**
 * What ends a run.
 *
 * A step that only THINKS between two batches of calls is not a boundary a reader cares about — it
 * is the same stretch of work with reasoning in the middle — so only a text reply, an operator
 * message or a nudge closes one.
 */
const brokenBy = (event: Event): boolean => {
  if (event.type === 'user-said' || event.type === 'nudge') return true
  if (event.type !== 'assistant-said') return false
  return event.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
}

export function toolRuns(events: readonly Event[]): ToolRun[] {
  const settles = settlesOf(events)
  const awaiting = awaitingApprovalIn(events)
  const attachments = attachmentsOf(events)
  const runs: CallSeed[][] = []
  let open = false

  for (const event of events) {
    if (brokenBy(event)) {
      open = false
      continue
    }
    if (event.type !== 'tool-called') continue

    if (open) runs.at(-1)?.push(seedOf(event))
    else runs.push([seedOf(event)])
    open = true
  }

  return runs.map((seeds) => runOf({ seeds, settles, awaiting, attachments }))
}

const NO_SETTLES: ReadonlyMap<CallId, Settle> = new Map()

const NONE_AWAITING: ReadonlyMap<CallId, string> = new Map()

const NO_ATTACHMENTS: ReadonlyMap<CallId, readonly ContextAttachment[]> = new Map()

export function liveToolRuns(calls: readonly LiveToolCall[]): LiveToolRun[] {
  const runs: { precededByBlocks: number; seeds: CallSeed[] }[] = []

  for (const call of calls) {
    const seed: CallSeed = { callId: call.callId, name: call.name, input: call.input, at: null }
    const open = runs.at(-1)

    if (open !== undefined && open.precededByBlocks === call.precededByBlocks) open.seeds.push(seed)
    else runs.push({ precededByBlocks: call.precededByBlocks, seeds: [seed] })
  }

  return runs.map((run) => ({
    run: runOf({ seeds: run.seeds, settles: NO_SETTLES, awaiting: NONE_AWAITING, attachments: NO_ATTACHMENTS }),
    precededByBlocks: run.precededByBlocks,
  }))
}
