import {
  EBeforeToolDecision,
  EToolEffect,
  hookOutcomeDrafts,
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
  type WorkspacePort,
} from '@dltech/atlas-core'

import { injectable } from '../container/injection'
import type { HookChain, RegisteredHook } from '../hooks/registry'
import type { ToolRegistry } from './registry'

export type DispatchableCall = { callId: CallId; name: string; input: unknown; runId: RunId }

export abstract class ToolDispatcher {
  abstract dispatch(args: {
    call: DispatchableCall
    signal: AbortSignal
    sessionDirectory: string
  }): Promise<readonly EventDraft[]>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const changesTheWorld = (effect: EToolEffect): boolean =>
  effect === EToolEffect.Write || effect === EToolEffect.Destructive

const MAX_REPORTED_ISSUES = 3

@injectable()
export class HookedToolDispatcher extends ToolDispatcher {
  private readonly registry: ToolRegistry
  private readonly hooks: HookChain
  private readonly workspace: WorkspacePort | undefined

  constructor(args: {
    registry: ToolRegistry
    hooks: HookChain
    workspace?: WorkspacePort | undefined
  }) {
    super()
    this.registry = args.registry
    this.hooks = args.hooks
    this.workspace = args.workspace
  }

  async dispatch(args: {
    call: DispatchableCall
    signal: AbortSignal
    sessionDirectory: string
  }): Promise<readonly EventDraft[]> {
    const { call, signal, sessionDirectory } = args
    const definition = this.registry.find(call.name)
    if (definition === undefined) return [this.unknownToolDraft({ call })]

    const parsed = definition.inputSchema.safeParse(call.input)
    if (!parsed.success) return [this.invalidInputDraft({ call, issues: parsed.error.issues })]

    const candidate: ToolCall = {
      callId: call.callId,
      name: call.name,
      input: parsed.data,
      effect: definition.effect,
    }

    const { outcome } = resolveBeforeTool({
      call: candidate,
      outcomes: await this.consultBeforeTool({ call: candidate }),
    })

    if (outcome.decision === EBeforeToolDecision.Deny) {
      return [{ type: 'tool-denied', callId: call.callId, name: call.name, reason: outcome.reason }]
    }

    if (outcome.decision === EBeforeToolDecision.Ask) {
      return [{ type: 'approval-requested', callId: call.callId, reason: outcome.reason }]
    }

    const allowed: ToolCall = { ...candidate, input: outcome.input }
    const idempotencyKey = `${call.runId}:${call.callId}`
    const result = await this.invokeTool({
      definition,
      call: allowed,
      signal,
      idempotencyKey,
      sessionDirectory,
    })

    return [
      this.resultDraft({ call: allowed, result, interrupted: signal.aborted }),
      ...(await this.observeAfterTool({ call: allowed, result })),
    ]
  }

  private unknownToolDraft(args: { call: DispatchableCall }): EventDraft {
    const available = this.registry.declarations().map((declaration) => declaration.name)
    const known = available.length === 0 ? 'none' : available.join(', ')
    return {
      type: 'tool-result',
      callId: args.call.callId,
      name: args.call.name,
      output: undefined,
      error: {
        message: `no tool named "${args.call.name}" is registered; available tools: ${known}`,
      },
    }
  }

  private invalidInputDraft(args: {
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

  private async outcomeOf(args: {
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

  private async consultBeforeTool(args: { call: ToolCall }): Promise<ConsultedHook[]> {
    const consulted: ConsultedHook[] = []
    let input = args.call.input

    for (const hook of this.hooks.beforeTool) {
      const outcome = await this.outcomeOf({ hook, call: { ...args.call, input } })
      if (outcome.decision === EBeforeToolDecision.Allow) input = outcome.input
      consulted.push({ hookName: hook.name, outcome })
    }

    return consulted
  }

  private async invokeTool(args: {
    definition: ToolDefinition
    call: ToolCall
    signal: AbortSignal
    idempotencyKey: string
    sessionDirectory: string
  }): Promise<ToolOutcome> {
    try {
      return await args.definition.invoke({
        input: args.call.input,
        signal: args.signal,
        idempotencyKey: args.idempotencyKey,
        sessionDirectory: args.sessionDirectory,
      })
    } catch (error) {
      return { ok: false, reason: `the ${args.call.name} tool threw: ${messageOf(error)}` }
    }
  }

  private async observeAfterTool(args: {
    call: ToolCall
    result: ToolOutcome
  }): Promise<EventDraft[]> {
    const observed: EventDraft[] = []

    for (const hook of this.hooks.afterTool) {
      try {
        const outcome = await hook.run({ call: args.call, result: args.result })
        observed.push(...hookOutcomeDrafts({ hookName: hook.name, outcome }))
      } catch {
        continue
      }
    }

    return observed
  }

  private resultDraft(args: { call: ToolCall; result: ToolOutcome; interrupted: boolean }): EventDraft {
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
      ...(args.interrupted ? { interrupted: true } : {}),
    }
  }
}
