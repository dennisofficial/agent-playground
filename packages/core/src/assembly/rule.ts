import type { Event } from '../events/envelope'
import type { ThreadId } from '../events/ids'
import type { ProviderIdentity } from '../provider'
import type { Assembled } from './assembled'
import type { AssemblyTrace } from './trace'

export type RuleContext = {
  events: readonly Event[]
  threadId: ThreadId
  step: number
  provider: ProviderIdentity
  countTokens: (value: Assembled) => number
  previous?: Assembled | undefined
}

export type RuleFn = (input: Assembled, ctx: RuleContext) => Assembled

export type Rule = RuleFn & { readonly ruleName: string }

export type AnnotatorFn = (input: Assembled, trace: AssemblyTrace, ctx: RuleContext) => Assembled

export type Annotator = AnnotatorFn & { readonly annotatorName: string }

export function defineRule({ name, apply }: { name: string; apply: RuleFn }): Rule {
  return Object.assign((input: Assembled, ctx: RuleContext) => apply(input, ctx), { ruleName: name })
}

export function defineAnnotator({ name, apply }: { name: string; apply: AnnotatorFn }): Annotator {
  return Object.assign(
    (input: Assembled, trace: AssemblyTrace, ctx: RuleContext) => apply(input, trace, ctx),
    { annotatorName: name },
  )
}
