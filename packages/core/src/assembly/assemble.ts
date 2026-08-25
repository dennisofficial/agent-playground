import type { Assembled } from './assembled'
import type { Annotator, Rule, RuleContext } from './rule'
import { EAssemblyStage, ERuleFailurePolicy, type AssemblyTrace, type AssemblyTraceStep } from './trace'

export type AssemblyRun = { assembled: Assembled; trace: AssemblyTrace }

type StageOutcome = { assembled: Assembled; failure?: string | undefined }

const emptyAssembled = (): Assembled => ({ system: [], messages: [] })

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function applyStage({
  apply,
  input,
  onRuleFailure,
}: {
  apply: () => Assembled
  input: Assembled
  onRuleFailure: ERuleFailurePolicy
}): StageOutcome {
  if (onRuleFailure === ERuleFailurePolicy.Throw) return { assembled: apply() }

  try {
    return { assembled: apply() }
  } catch (error) {
    return { assembled: input, failure: failureMessage(error) }
  }
}

function traceStep({
  stage,
  name,
  outcome,
  ctx,
}: {
  stage: EAssemblyStage
  name: string
  outcome: StageOutcome
  ctx: RuleContext
}): AssemblyTraceStep {
  return {
    stage,
    name,
    systemBlocks: outcome.assembled.system.length,
    messages: outcome.assembled.messages.length,
    tokens: ctx.countTokens(outcome.assembled),
    failure: outcome.failure,
  }
}

export function assemble({
  rules,
  annotators = [],
  ctx,
  onRuleFailure = ERuleFailurePolicy.SkipRule,
}: {
  rules: readonly Rule[]
  annotators?: readonly Annotator[]
  ctx: RuleContext
  onRuleFailure?: ERuleFailurePolicy
}): AssemblyRun {
  const trace: AssemblyTraceStep[] = []
  let current = emptyAssembled()

  for (const rule of rules) {
    const outcome = applyStage({ apply: () => rule(current, ctx), input: current, onRuleFailure })
    trace.push(traceStep({ stage: EAssemblyStage.Rule, name: rule.ruleName, outcome, ctx }))
    current = outcome.assembled
  }

  for (const annotator of annotators) {
    const seen: AssemblyTrace = [...trace]
    const outcome = applyStage({
      apply: () => annotator(current, seen, ctx),
      input: current,
      onRuleFailure,
    })
    trace.push(traceStep({ stage: EAssemblyStage.Annotator, name: annotator.annotatorName, outcome, ctx }))
    current = outcome.assembled
  }

  return { assembled: current, trace }
}
