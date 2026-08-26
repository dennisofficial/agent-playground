import {
  EBeforeToolDecision,
  resolveBeforeTool,
  type AfterTool,
  type BeforeTool,
  type BeforeToolOutcome,
  type CallId,
  type ConsultedHook,
  type EventDraft,
  type RunId,
  type ToolCall,
  type ToolDefinition,
  type ToolOutcome,
} from '@dltech/atlas-core'

import type { HookRegistry, RegisteredHook } from '../hooks/registry'
import type { ToolRegistry } from './registry'

export type DispatchableCall = { callId: CallId; name: string; input: unknown; runId: RunId }

export type Dispatch = (args: {
  call: DispatchableCall
  signal: AbortSignal
}) => Promise<readonly EventDraft[]>

function unknownToolDraft(args: { call: DispatchableCall; available: readonly string[] }): EventDraft {
  const known = args.available.length === 0 ? 'none' : args.available.join(', ')
  return {
    type: 'tool-result',
    callId: args.call.callId,
    name: args.call.name,
    output: undefined,
    error: { message: `no tool named "${args.call.name}" is registered; available tools: ${known}` },
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const MAX_REPORTED_ISSUES = 3

function invalidInputDraft(args: {
  call: DispatchableCall
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): EventDraft {
  const problems = args.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => {
      const field = issue.path.map(String).join('.')
      return field === '' ? issue.message : `${field}: ${issue.message}`
    })
    .join('; ')

  return {
    type: 'tool-result',
    callId: args.call.callId,
    name: args.call.name,
    output: undefined,
    error: {
      message: `the ${args.call.name} tool rejected this input: ${problems === '' ? 'it does not match the schema' : problems}`,
    },
  }
}

async function outcomeOf(args: {
  hook: RegisteredHook<BeforeTool>
  call: ToolCall
}): Promise<BeforeToolOutcome> {
  try {
    return await args.hook.run({ call: args.call })
  } catch (error) {
    return {
      decision: EBeforeToolDecision.Deny,
      reason: `the ${args.hook.name} hook failed: ${messageOf(error)}`,
    }
  }
}

async function consultBeforeTool(args: {
  hooks: readonly RegisteredHook<BeforeTool>[]
  call: ToolCall
}): Promise<ConsultedHook[]> {
  const consulted: ConsultedHook[] = []
  let input = args.call.input

  for (const hook of args.hooks) {
    const outcome = await outcomeOf({ hook, call: { ...args.call, input } })
    if (outcome.decision === EBeforeToolDecision.Allow) input = outcome.input
    consulted.push({ hookName: hook.name, outcome })
  }

  return consulted
}

async function invokeTool(args: {
  definition: ToolDefinition
  call: ToolCall
  signal: AbortSignal
  idempotencyKey: string
}): Promise<ToolOutcome> {
  try {
    return await args.definition.invoke({
      input: args.call.input,
      signal: args.signal,
      idempotencyKey: args.idempotencyKey,
    })
  } catch (error) {
    return { ok: false, reason: `the ${args.call.name} tool threw: ${messageOf(error)}` }
  }
}

async function observeAfterTool(args: {
  hooks: readonly RegisteredHook<AfterTool>[]
  call: ToolCall
  result: ToolOutcome
}): Promise<EventDraft[]> {
  const observed: EventDraft[] = []

  for (const hook of args.hooks) {
    try {
      observed.push(...(await hook.run({ call: args.call, result: args.result })))
    } catch {
      continue
    }
  }

  return observed
}

function resultDraft(args: { call: ToolCall; result: ToolOutcome }): EventDraft {
  if (args.result.ok) {
    return {
      type: 'tool-result',
      callId: args.call.callId,
      name: args.call.name,
      output: args.result.output,
      modelText: args.result.modelText,
    }
  }

  return {
    type: 'tool-result',
    callId: args.call.callId,
    name: args.call.name,
    output: undefined,
    error: { message: args.result.reason },
  }
}

export function createDispatch(deps: { registry: ToolRegistry; hooks: HookRegistry }): Dispatch {
  return async ({ call, signal }) => {
    const definition = deps.registry.find(call.name)
    if (definition === undefined) {
      return [
        unknownToolDraft({
          call,
          available: deps.registry.declarations().map((declaration) => declaration.name),
        }),
      ]
    }

    const parsed = definition.inputSchema.safeParse(call.input)
    if (!parsed.success) return [invalidInputDraft({ call, issues: parsed.error.issues })]

    const candidate: ToolCall = {
      callId: call.callId,
      name: call.name,
      input: parsed.data,
      effect: definition.effect,
    }

    const { outcome } = resolveBeforeTool({
      call: candidate,
      outcomes: await consultBeforeTool({ hooks: deps.hooks.beforeTool, call: candidate }),
    })

    if (outcome.decision === EBeforeToolDecision.Deny) {
      return [{ type: 'tool-denied', callId: call.callId, name: call.name, reason: outcome.reason }]
    }

    if (outcome.decision === EBeforeToolDecision.Ask) {
      return [{ type: 'approval-requested', callId: call.callId, reason: outcome.reason }]
    }

    const allowed: ToolCall = { ...candidate, input: outcome.input }
    const result = await invokeTool({
      definition,
      call: allowed,
      signal,
      idempotencyKey: `${call.runId}:${call.callId}`,
    })

    return [
      resultDraft({ call: allowed, result }),
      ...(await observeAfterTool({ hooks: deps.hooks.afterTool, call: allowed, result })),
    ]
  }
}
