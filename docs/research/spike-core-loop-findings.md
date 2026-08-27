# Core-loop spike findings

Source: `.spikes/core-loop/` (gitignored). 22 passing tests, `tsc --noEmit` clean, mock model only
(`MockLanguageModelV4` from `ai/test`), `ai@7.0.77`. Recorded 2026-08-24.

These are **findings**, not decisions. The contract rewrite happens once all four spikes land.

## It decomposes

820 source lines across 24 files. **Largest file: 84 lines.** Nothing approached the 300-line cap.

Seams the tests actually exercise by swapping them:

- **`EventLog`** — in-memory ↔ SQLite. Only the runner and settle path import it, via append/read/head.
  `read({upTo})` already supports rewind. A real database changes exactly one thing: `seq` assignment,
  which needs a per-thread unique constraint or a transaction rather than array length.
- **`ModelStep`** — `(assembled, tools, hooks) => {parts, toolCalls}`. The entire AI SDK sits behind
  this one function type; the runner never imports `ai`.
- **`Rule[]`** — ordered, pure, composed by reduce. A new rule is a new file.
- **`ToolRegistry`** — `defineTool<TInput>` erases to `unknown` and re-establishes the type by calling
  `inputSchema.parse` inside the wrapper. No cast, no generic leaking into the registry.

Seams that turned out to be **fake**: the runner/settle split (settle cannot be tested or swapped
independently of the driver's invariant — 156 lines pretending to be two modules), and assemble vs
rules (assemble is a three-line reduce; the rules are the module).

## Resume is free

There is no resume implementation. `resume` is the drive loop, because the loop re-derives position
from the log each iteration rather than holding a cursor. One projection carries it:

```ts
export function pendingCalls(events: readonly Event[]): PendingCall[] {
  const settled = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool-result' || event.type === 'tool-denied') settled.add(event.callId)
  }
  return eventsOfType({ events, type: 'tool-called' })
    .filter((event) => !settled.has(event.callId))
    .map((event) => ({ callId: event.callId, name: event.name, input: event.input }))
}
```

"Start a turn" and "resume a turn" become one operation, and resume is idempotent for free.

Proved by serializing the log to JSON, discarding runner/model/registry/rules/clock, rebuilding from
that string alone **with a different model script** — one step instead of two, so a replayed model
call would fail — and completing the turn.

**Cost:** assembly re-runs over the whole log every step, O(n²) in events per turn. Invisible at
spike scale; not invisible at 500 events. Needs incremental assembly over a cached prefix.

## Contract defects to fix

1. **`BeforeTool: (call) => ...` breaks resume, silently.** On resume the call is still pending, so
   the hook fires again and returns `ask` again — an infinite pause. A resolver must read
   `approval-answered` from the log *before* the hook is consulted. Either the hook receives the log
   in its context, or the contract states the resolver explicitly.
2. **No event for a tool that failed.** `tool-result` implies success and `tool-denied` means policy
   refused; a throwing tool has no slot, so a crash renders to the model as a JSON success. Add
   `tool-failed`, or put `isError` on `tool-result` — assembly needs to be able to tell.
3. **`Assembled.system: string[]` discards cache breakpoints.** ai@7's `instructions` takes
   `SystemModelMessage[]`, each carrying `providerOptions` — where an Anthropic `cache_control`
   breakpoint goes. Should be `Array<{content: string; providerOptions?: ProviderOptions}>`.
   Separately: system messages cannot go in `messages` at all in ai@7 — it throws
   `AI_InvalidPromptError` unless `allowSystemInMessages` is set.
4. **`tool-called` + `assistant-said` lose intra-message ordering.** A step emitting
   text → tool-call → text collapses to (all text)(all calls), because `seq` across two event kinds
   is the only ordering signal. Either `assistant-said.parts` carries tool-call parts and
   `tool-called` becomes a derived index, or `tool-called` needs an ordinal within the step.
5. **`AfterTool`/`AfterTurn` cannot return `Event[]`.** Only the log can assign `id`/`seq`/`at`, so
   hooks must return drafts.
6. **`assemble(events, rules)` is the wrong signature** — `RuleContext` carries `threadId` and
   `budget`, neither derivable from events. Real shape: `assemble({events, rules, threadId, budget})`.
7. **`tool-result` has no `name`**, so every renderer joins back to `tool-called` for the `toolName`
   the SDK requires on a `ToolResultPart` — with an `?? 'unknown'` fallback that can emit a
   malformed prompt.
8. **`runId` is undefined and unconsumed.** Define it or delete it.
9. **`nudge.ephemeral: true` names a property, not a behaviour.** The spike invented one (render only
   if no `assistant-said` follows) and that guess became load-bearing.

## The providerOptions warning pointed at the wrong module

The contract warned that assembly rules must preserve `providerOptions` on reasoning parts. Rules are
not where this breaks — **the stream accumulator is**. `providerMetadata` arrives on
`reasoning-start`, on every `reasoning-delta`, and on `reasoning-end` (where Anthropic's signature
actually lands), and must be written back out under the different request-side name
`providerOptions`. That merge is the real failure point. Pinned by a test asserting
`{anthropic: {signature: 'sig-abc'}}` survives into the next prompt.

## AI SDK behaviours worth knowing

- **`streamText` does not throw on model errors.** It emits `{type: 'error'}` into `fullStream`. The
  spike's first run produced silently empty assistant turns that looked like successful completions.
  A hand-rolled loop must handle that chunk explicitly. This applies to any loop over `streamText`.
- **`stopWhen: stepCountIs(1)` is not the stopping mechanism.** Verified by deleting it — all tests
  still passed. A tool declared without `execute` is what stops the SDK, because it cannot
  manufacture a tool result. Keep the stop condition as documentation, not as the mechanism.
- **`ai` does not export `ProviderOptions`, `ToolResultOutput`, or the message part interfaces.**
  They live in `@ai-sdk/provider-utils`.
- ai@7 ships its own approval mechanism (`toolApproval`, `needsApproval`, `tool-approval-request`
  parts). It is in-band within one `streamText` call and so cannot survive process death, but the
  SDK may emit approval parts an accumulator would otherwise ignore. Ignore it deliberately.

## Open decision this forces

`Assembled` contains `ModelMessage[]`, so **`core` cannot depend on nothing but zod**, as `CLAUDE.md`
currently states. Either `core` owns its own message type and `providers` converts, or `core` depends
on the AI SDK.

This is upstream of every other spike. Leaning toward core owning its own type: it is the only
version where swapping the model layer leaves the domain untouched, which is the difference between
model-agnostic being true and being aspirational.
