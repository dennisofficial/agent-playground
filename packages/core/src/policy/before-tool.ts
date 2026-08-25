export enum EBeforeToolDecision {
  Allow = 'allow',
  Ask = 'ask',
  Deny = 'deny',
}

export type BeforeToolOutcome =
  | { decision: EBeforeToolDecision.Allow; input: unknown }
  | { decision: EBeforeToolDecision.Ask; reason: string }
  | { decision: EBeforeToolDecision.Deny; reason: string }

export type HookDissent = { hookName: string; decision: EBeforeToolDecision; reason: string }

export type BeforeToolResolution = {
  outcome: BeforeToolOutcome
  dissenters: readonly HookDissent[]
}
