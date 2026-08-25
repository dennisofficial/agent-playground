# Assembly-rules spike findings

Source: `.spikes/assembly-rules/` (gitignored). 45 passing tests, `tsc --noEmit` clean, pure
synthetic data (42 events), `ai@7.0.77` + `@ai-sdk/anthropic@4.0.41`. Recorded 2026-08-24.

The spike was briefed to **attack** the claim that every context behaviour is "just a rule" in a pure
ordered pipeline. It did.

## Verdict: two of the six rules are not rules

- **Content policy — the claim holds.** Rules deciding what the model sees compose as pure
  `(Assembled) => Assembled`. Better than expected: even the events→messages projection is a
  legitimate rule (`projectEvents`, phase Project), so there is no privileged pre-pipeline stage and
  the claim is not cheating.
- **Annotation — the claim fails.** Cache breakpoints and provenance forced `Rule` to grow metadata,
  forced harness bookkeeping into the wire field `providerOptions`, and forced a seventh cleanup rule
  that must run last or internal ids ship to the provider.
- **Budgeting — the claim fails.** In-pipeline, the budget rule overshoots. Lifted into a controller
  it performs far better.

## Order dominates, and ordering metadata cannot fix it

Same rules, same data, two array positions swapped:

```ts
reduceThenBudget.messages.length  // 28
budgetThenReduce.messages.length  // 10
```

A `phase` enum with a startup-time order check was added, and then shown to be insufficient at n=6:
`enforceTokenBudget` is classified Budget but **writes to the system block**, so one rule already
needs two phases at once. Any summarizing rule drops *and* injects by definition.

The failure that costs money is worse: cache-breakpoint validity is a **between-step** property.

```ts
expect(roomyMarked).toBe(tightMarked)                             // same breakpoint index
expect(tight.system.length).toBeGreaterThan(roomy.system.length)  // different cached prefix
```

Both pipelines were internally well-ordered. No within-step annotation can express this.

**Recommendation: declare effects** — reads/writes over `{system, messages, providerOptions,
provenance}` — so the checker catches "writes system after something annotated a prefix including
system". `phase` is that idea with the resolution turned down until it stops catching anything.

## Purity does not buy composability

`ctx.events` is the whole log, so any rule can ignore its input and rebuild from scratch. An
`amnesiac` rule at phase Reduce silently discards three rules' work and restores all 28 messages.
Nothing in the type prevents it, and a careless re-projection does it by accident.

## The real argument for purity

Not testability — **fixpoint search**. Because rules are pure and cheap, re-running the entire
pipeline is free, so a controller can search over assembly parameters until the result fits:

```ts
for (const [rung, pressure] of ladder.entries()) {
  const run = assembleWithTrace({ events, rules: [...buildRules(pressure), ...finishers], branchId, budget })
  if (estimateTokens(run.assembled) <= budget.maxTokens) return { ...run, rung, truncated: false }
}
```

Escalating `{thinkingTurns, nudgeLifetimeSteps, keepImages}`, truncating only when the whole ladder
fails. **Preserves 26 messages where the in-pipeline budget rule kept 7** for the same 1500-token
budget — which had thrown away 92% of remaining context (2134 → 176 tokens) because the only safe
move for a pure function is dropping a whole turn group from the front; anything finer orphans a
`tool-result` from its `tool-call`.

Split the responsibility: **measurement** is a memoized service on the context; **enforcement** is a
controller above the pipeline.

## `RuleContext` is short by five things

1. **A step counter.** `dropEphemeral({olderThanSteps})` is defined in steps and the context has
   none, so every ephemerality rule re-derives it and each may define "step" differently.
2. **Provider/model identity.** `placeCacheBreakpoints` writes `providerOptions.anthropic.*` with no
   way to know the model is Anthropic. Against OpenAI it emits silently dead config.
3. **A token counter**, memoized, rather than every size-aware rule re-walking the array.
4. **The previous step's `Assembled`**, without which cache-prefix stability is unknowable in
   principle.
5. **One home for `maxTokens`**, which currently lives in both `ctx.budget` and the rule's argument.

`assemble(events, rules)` also cannot build a `RuleContext` — no `branchId`, no `budget`. Named
parameters, per the repo's own 2+-args rule.

## Keep the signature pure and synchronous, with two amendments

**Async is not needed, and the contract already explains why.** Loading a skill body from disk
belongs in `AfterTool`, which appends a `context-loaded` event; `injectLoadedContext` then renders it
as a pure function of the log. The only case forcing async is a rule discovering mid-assembly that it
needs content not yet in the log — and the fix is a rule returning a *request* the harness fulfils
before the next step, not `async Rule`. Making rules async makes every rewind, fork, and dry-run
assembly an I/O operation.

1. **Fallible-tolerant.** One throwing rule currently kills the turn. Under `ERuleFailurePolicy.SkipRule`
   the rule is skipped, its input passes through, and the failure is recorded on the trace. Degraded
   context beats a dead turn.
2. **Return `{assembled, trace}`.** Twenty lines, and the single most useful thing in the spike — at
   six rules you already cannot answer "which rule dropped that message?". The trace is also exactly
   what an annotator stage needs to read.

## Type-level costs

`Assembled.messages: ModelMessage[]` makes "map over parts" inexpressible without per-role
re-narrowing. `downgrade-old-images.ts` is 98 lines, ~30 of them rebuilding a union member the
compiler already lost — precisely where a tired engineer writes `as any`. An `AssembledMessage =
{ message, origin }` wrapper with a typed part-mapper collapses that **and** removes the provenance
smuggle.

`system: string[]` has nowhere to put `providerOptions`, so the system block cannot carry its own
cache breakpoint — even though `@ai-sdk/anthropic` reads `cacheControl` off
`SystemModelMessage.providerOptions` (verified in its `dist/index.js`). Proposed:

```ts
type SystemBlock = { text: string; providerOptions?: ProviderOptions }
type Assembled = { system: SystemBlock[]; messages: ModelMessage[] }
```

## Why it reads well at six and breaks at twenty

The eight-rule pipeline reads beautifully, but for a reason that will not survive: these rules happen
to form a clean funnel (build, add, subtract, fit, annotate, clean). That is a property of the
sample, not of the abstraction. Four failure modes, all already visible at six:

1. Array position encodes semantics appearing nowhere in the names.
2. The Reduce phase becomes an unordered bag with intra-phase constraints the enum cannot express.
3. O(rules × messages) — twenty passes over a 500-message log on every step of every turn.
4. No rule can tell whether its concern was already handled, so two independently written reduction
   rules both fire on the same oversized tool result and one's work is wasted.

## Changes to make

- Split `Rule` (content policy) from `Annotator = (Assembled, AssemblyTrace) => Assembled`.
- Lift budget enforcement into a controller running the fixpoint ladder.
- Add the five missing `RuleContext` fields; give `assemble` named parameters.
- `SystemBlock[]` for system; `AssembledMessage` wrapper for messages and provenance.
- Return a trace; add a rule-failure policy.
- Prefer declared effects over a phase enum.
