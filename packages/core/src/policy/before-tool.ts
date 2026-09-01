import type { EventDraft } from '../events/body'
import type { ToolCall } from '../tools/tool'

export enum EBeforeToolDecision {
  Allow = 'allow',
  Ask = 'ask',
  Deny = 'deny',
}

export type BeforeToolOutcome =
  | { decision: EBeforeToolDecision.Allow; input: unknown; drafts?: readonly EventDraft[] | undefined }
  | { decision: EBeforeToolDecision.Ask; reason: string; drafts?: readonly EventDraft[] | undefined }
  | { decision: EBeforeToolDecision.Deny; reason: string; drafts?: readonly EventDraft[] | undefined }

export type HookDissent = { hookName: string; decision: EBeforeToolDecision; reason: string }

export type BeforeToolResolution = {
  outcome: BeforeToolOutcome
  dissenters: readonly HookDissent[]
  drafts: readonly EventDraft[]
}

export type ConsultedHook = { hookName: string; outcome: BeforeToolOutcome }

function dissentsAmong(outcomes: readonly ConsultedHook[]): HookDissent[] {
  return outcomes.flatMap(({ hookName, outcome }) =>
    outcome.decision === EBeforeToolDecision.Allow
      ? []
      : [{ hookName, decision: outcome.decision, reason: outcome.reason }],
  )
}

function firstDissentFor(args: {
  dissenters: readonly HookDissent[]
  decision: EBeforeToolDecision.Ask | EBeforeToolDecision.Deny
}): HookDissent | undefined {
  return args.dissenters.find((dissent) => dissent.decision === args.decision)
}

function reasonOf(dissent: HookDissent): string {
  if (typeof dissent.reason === 'string' && dissent.reason !== '') return dissent.reason
  return `the ${dissent.hookName} hook returned ${dissent.decision} without a reason`
}

function lastAllowedInput(args: { outcomes: readonly ConsultedHook[]; fallback: unknown }): unknown {
  const allowed = args.outcomes
    .map(({ outcome }) => outcome)
    .filter((outcome) => outcome.decision === EBeforeToolDecision.Allow)
    .at(-1)

  return allowed === undefined ? args.fallback : allowed.input
}

function draftsAmong(outcomes: readonly ConsultedHook[]): readonly EventDraft[] {
  return outcomes.flatMap(({ outcome }) => outcome.drafts ?? [])
}

export function resolveBeforeTool(args: {
  call: ToolCall
  outcomes: readonly ConsultedHook[]
}): BeforeToolResolution {
  const dissenters = dissentsAmong(args.outcomes)
  const drafts = draftsAmong(args.outcomes)

  const denial = firstDissentFor({ dissenters, decision: EBeforeToolDecision.Deny })
  if (denial !== undefined) {
    return {
      outcome: { decision: EBeforeToolDecision.Deny, reason: reasonOf(denial) },
      dissenters,
      drafts,
    }
  }

  const question = firstDissentFor({ dissenters, decision: EBeforeToolDecision.Ask })
  if (question !== undefined) {
    return {
      outcome: { decision: EBeforeToolDecision.Ask, reason: reasonOf(question) },
      dissenters,
      drafts,
    }
  }

  return {
    outcome: {
      decision: EBeforeToolDecision.Allow,
      input: lastAllowedInput({ outcomes: args.outcomes, fallback: args.call.input }),
    },
    dissenters,
    drafts,
  }
}
