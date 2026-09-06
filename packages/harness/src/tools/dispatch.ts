import {
  EBeforeToolDecision,
  EToolEffect,
  hookOutcomeDrafts,
  resolveBeforeTool,
  type ActiveWorktree,
  type AfterTool,
  type BeforeTool,
  type BeforeToolOutcome,
  type CallId,
  type ConsultedHook,
  type Event,
  type EventDraft,
  type RunId,
  type ThreadId,
  type ToolCall,
  type ToolDefinition,
  type ToolOutcome,
  type OnToolOutput,
  type WorkspacePort,
  type HookOutcome,
} from '@dltech/atlas-core'

import { withinBudget, type OnHookMishap } from '../hooks/budget'
import type { HookChain, RegisteredHook } from '../hooks/registry'
import { EApprovalRouting, unattendedReason } from './approval-routing'
import { outcomeWhenAHookDidNotAnswerInTime } from './hook-silence'
import type { ToolRegistry } from './registry'

export { EApprovalRouting }

export type DispatchableCall = {
  callId: CallId
  name: string
  input: unknown
  runId: RunId
  threadId: ThreadId
}

export abstract class ToolDispatcher {
  abstract dispatch(args: {
    call: DispatchableCall
    signal: AbortSignal
    projectDirectory: string
    homeDirectory?: string | undefined
    events: readonly Event[]
    activeWorktree?: ActiveWorktree | undefined
    onOutput?: OnToolOutput | undefined
  }): Promise<readonly EventDraft[]>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const NO_OUTCOME: HookOutcome = {}

const changesTheWorld = (effect: EToolEffect): boolean =>
  effect === EToolEffect.Write || effect === EToolEffect.Destructive

const MAX_REPORTED_ISSUES = 3

export class HookedToolDispatcher extends ToolDispatcher {
  private readonly registry: ToolRegistry
  private readonly hooks: HookChain
  private readonly approvals: EApprovalRouting
  private readonly workspace: WorkspacePort | undefined
  private readonly onMishap: OnHookMishap | undefined

  constructor(args: {
    registry: ToolRegistry
    hooks: HookChain
    approvals: EApprovalRouting
    workspace?: WorkspacePort | undefined
    onMishap?: OnHookMishap | undefined
  }) {
    super()
    this.registry = args.registry
    this.hooks = args.hooks
    this.approvals = args.approvals
    this.workspace = args.workspace
    this.onMishap = args.onMishap ?? args.hooks.bounds.onMishap
  }

  async dispatch(args: {
    call: DispatchableCall
    signal: AbortSignal
    projectDirectory: string
    homeDirectory?: string | undefined
    events: readonly Event[]
    activeWorktree?: ActiveWorktree | undefined
    onOutput?: OnToolOutput | undefined
  }): Promise<readonly EventDraft[]> {
    const { call, signal, projectDirectory, homeDirectory, activeWorktree, events, onOutput } = args
    const definition = this.registry.find(call.name)
    if (definition === undefined) return [this.unknownToolDraft({ call })]

    const parsed = definition.inputSchema.safeParse(call.input)
    if (!parsed.success) return [this.invalidInputDraft({ call, issues: parsed.error.issues })]

    const candidate: ToolCall = {
      callId: call.callId,
      name: call.name,
      input: parsed.data,
      effect: definition.effect,
      threadId: call.threadId,
    }

    const { outcome, drafts } = resolveBeforeTool({
      call: candidate,
      outcomes: await this.consultBeforeTool({ call: candidate, projectDirectory, events, signal }),
    })

    if (outcome.decision === EBeforeToolDecision.Deny) {
      return [
        ...drafts,
        { type: 'tool-denied', callId: call.callId, name: call.name, reason: outcome.reason },
      ]
    }

    if (outcome.decision === EBeforeToolDecision.Ask) {
      if (this.approvals === EApprovalRouting.None) {
        return [
          ...drafts,
          {
            type: 'tool-denied',
            callId: call.callId,
            name: call.name,
            reason: unattendedReason({ reason: outcome.reason }),
          },
        ]
      }

      return [...drafts, { type: 'approval-requested', callId: call.callId, reason: outcome.reason }]
    }

    const allowed: ToolCall = { ...candidate, input: outcome.input }
    const idempotencyKey = `${call.runId}:${call.callId}`
    const result = await this.invokeTool({
      definition,
      call: allowed,
      signal,
      idempotencyKey,
      projectDirectory,
      homeDirectory,
      activeWorktree,
      threadId: call.threadId,
      onOutput,
    })

    return [
      ...drafts,
      this.resultDraft({ call: allowed, result, interrupted: signal.aborted }),
      ...(await this.observeAfterTool({ call: allowed, result, signal })),
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
    projectDirectory: string
    events: readonly Event[]
    signal: AbortSignal
  }): Promise<BeforeToolOutcome> {
    return withinBudget({
      label: args.hook.name,
      run: () =>
        args.hook.run({
          call: args.call,
          projectDirectory: args.projectDirectory,
          events: args.events,
          signal: args.signal,
        }),
      fallback: (mishap) => outcomeWhenAHookDidNotAnswerInTime({ mishap, call: args.call }),
      budgetMs: this.hooks.bounds.budgetMs,
      onMishap: this.onMishap,
    })
  }

  private async consultBeforeTool(args: {
    call: ToolCall
    projectDirectory: string
    events: readonly Event[]
    signal: AbortSignal
  }): Promise<ConsultedHook[]> {
    const consulted: ConsultedHook[] = []
    let input = args.call.input

    for (const hook of this.hooks.beforeTool) {
      const outcome = await this.outcomeOf({
        hook,
        call: { ...args.call, input },
        projectDirectory: args.projectDirectory,
        events: args.events,
        signal: args.signal,
      })
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
    projectDirectory: string
    homeDirectory: string | undefined
    activeWorktree: ActiveWorktree | undefined
    threadId: ThreadId
    onOutput: OnToolOutput | undefined
  }): Promise<ToolOutcome> {
    try {
      return await args.definition.invoke({
        input: args.call.input,
        signal: args.signal,
        idempotencyKey: args.idempotencyKey,
        projectDirectory: args.projectDirectory,
        homeDirectory: args.homeDirectory,
        activeWorktree: args.activeWorktree,
        threadId: args.threadId,
        onOutput: args.onOutput,
      })
    } catch (error) {
      return { ok: false, reason: `the ${args.call.name} tool threw: ${messageOf(error)}` }
    }
  }

  private async observeAfterTool(args: {
    call: ToolCall
    result: ToolOutcome
    signal: AbortSignal
  }): Promise<EventDraft[]> {
    const observed: EventDraft[] = []

    for (const hook of this.hooks.afterTool) {
      const outcome = await withinBudget({
        label: hook.name,
        run: () => hook.run({ call: args.call, result: args.result, signal: args.signal }),
        fallback: () => NO_OUTCOME,
        budgetMs: this.hooks.bounds.budgetMs,
        onMishap: this.onMishap,
      })
      observed.push(...hookOutcomeDrafts({ hookName: hook.name, outcome }))
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
        ...(args.result.modelParts === undefined ? {} : { modelParts: args.result.modelParts }),
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
