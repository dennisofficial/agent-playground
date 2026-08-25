# Core contract

The seams of `@dltech/atlas-core`. Derived from four spikes, not from argument — every clause below
that carries a *why* earned it by breaking in code. Evidence lives in `docs/research/`.

Supersedes `docs/spike-contract.md`, which the spikes were briefed to attack and did.

## The one rule

The model never sees stored state. It sees a projection built fresh for every step.

```
EventLog (append-only, canonical)  →  assemble(rules)  →  annotate  →  Assembled  →  one model step
```

There is no accumulating `messages[]`. Position, context, and pending work are all pure functions of
the log. This is what made resume free in the core-loop spike (`resume: drive`) and what makes fork
cost one row.

**One record.** If a checkpoint and the log are two records of the same run, keeping them from
drifting on rewind is permanent work. This is why no graph framework is used.

## Events

```ts
type EventEnvelope = { id: string; seq: number; branchId: string; runId: string; at: string }
type EventDraft = EventBody                      // what callers and hooks author
type Event = EventBody & EventEnvelope           // what the log returns
```

Only the log assigns `id`/`seq`/`at` — `seq` is its core invariant. **Hooks return
`EventDraft[]`, never `Event[]`**; both the core-loop and hooks-di spikes hit this independently.

```ts
type EventBody =
  | { type: 'user-said';          text: string }
  | { type: 'assistant-said';     parts: AssistantPart[]; interrupted?: boolean }
  | { type: 'tool-called';        callId: string; name: string; input: unknown; ordinal: number }
  | { type: 'tool-result';        callId: string; name: string; output: unknown
                                  error?: { message: string }; snapshotId?: string }
  | { type: 'tool-denied';        callId: string; name: string; reason: string }
  | { type: 'approval-requested'; callId: string; reason: string }
  | { type: 'approval-answered';  callId: string; decision: EDecision; editedInput?: unknown }
  | { type: 'context-loaded';     slot: string; key: string; content: string; triggeredBy?: string }
  | { type: 'nudge';              text: string; lifetimeSteps: number }
```

- **`tool-result.error` distinguishes a crash from a denial.** *Denied* means policy said no; a
  missing file is not a denial. Without this, assembly renders a crash to the model as a successful
  JSON result.
- **`tool-result.name` is duplicated deliberately.** The SDK requires `toolName` on a
  `ToolResultPart`, and joining back to `tool-called` for it produced an `?? 'unknown'` fallback that
  can emit a malformed prompt.
- **`tool-called.ordinal` fixes intra-step ordering.** `seq` alone across two event kinds collapses
  text → tool-call → text into (all text)(all calls).
- **`nudge.lifetimeSteps` replaces `ephemeral: true`**, which named a property rather than a
  behaviour and forced the core-loop spike to invent semantics that became load-bearing.
- **`context-loaded` is the general mechanism** for anything the model sees that is not a message: a
  `CLAUDE.md` pulled in because a tool touched a directory beneath it, a skill body, MCP tool
  descriptions. `key` is the dedup identity.

**`append` is idempotent on `(branchId, slot, key)` for `context-loaded`.** Otherwise every
context-loading hook reimplements dedup, and one that forgets spams the prompt forever.

## Log

```ts
interface EventLog {
  append(args: { branchId: string; runId: string; drafts: readonly EventDraft[] }): Promise<Event[]>
  read(args: { branchId: string; upTo?: number }): Promise<Event[]>
  head(args: { branchId: string }): Promise<number>
  forkFrom(args: { branchId: string; seq: number; into: string }): Promise<void>
}
```

`seq` must be assigned under a per-branch unique constraint or a transaction — array length does not
survive concurrency, and background agents mean two writers.

## Assembly

```ts
type SystemBlock = { text: string; providerOptions?: ProviderOptions }
type AssembledMessage = { message: ModelMessage; origin: EventRef }
type Assembled = { system: SystemBlock[]; messages: AssembledMessage[] }
```

- **`system` is blocks, not strings.** Plain strings cannot carry a cache breakpoint, and
  `@ai-sdk/anthropic` reads `cacheControl` off `SystemModelMessage.providerOptions`. Note ai@7
  forbids system messages in `messages` entirely — they go in `instructions`.
- **`AssembledMessage.origin` carries provenance out-of-band.** `ModelMessage` has nowhere to hold
  it, and smuggling it through `providerOptions` forced a cleanup rule without which internal ids
  ship to the provider on every turn. The wrapper also removes ~30 lines of union re-narrowing —
  precisely where a tired engineer writes `as any`.

```ts
type Rule = (input: Assembled, ctx: RuleContext) => Assembled
type Annotator = (input: Assembled, trace: AssemblyTrace, ctx: RuleContext) => Assembled

type RuleContext = {
  events: readonly Event[]
  branchId: string
  step: number
  provider: { id: string; modelId: string }
  countTokens(value: Assembled): number
  previous?: Assembled
}

function assemble(args: { rules: readonly Rule[]; annotators?: readonly Annotator[]
                          ctx: RuleContext
                          onRuleFailure?: ERuleFailurePolicy }): { assembled: Assembled; trace: AssemblyTrace }
```

**Rules are pure and synchronous.** Not for testability — because re-running a cheap pure pipeline is
free, which makes fixpoint search over assembly parameters trivial (see the budget controller). Async
would make every rewind, fork, and dry-run assembly an I/O operation. Content that must be loaded
arrives via `AfterTool` appending `context-loaded`, and a rule renders it.

**Rules do content policy. Annotators do metadata.** Cache breakpoints, provenance, and budget
accounting are not peers of content rules — every one needed an escape hatch when forced into the
`Rule` shape. Annotators run once afterwards with read access to the trace.

**Budget enforcement is not a rule.** It is a controller *above* the pipeline that re-runs assembly
at escalating pressure and truncates only if the whole ladder fails. In-pipeline it overshot a
1500-token budget down to 176 — discarding 92% of remaining context — because the only safe move for
a pure function is dropping a whole turn group. The controller kept 26 messages where the rule kept 7.

**`onRuleFailure`.** One throwing rule must not kill the turn; under `SkipRule` its input passes
through and the failure is recorded on the trace. Degraded context beats a dead turn. It defaults to
`SkipRule`, and it governs **annotators too** — a throwing annotator killing a turn that a throwing
rule survives would be indefensible.

**`assemble` takes no `events` of its own.** Rules can only read `ctx.events`, so a second copy at the
top level could do nothing but drift from the one rules actually see. An earlier revision of this
document specified it; the implementation dropped it.

**`Rule` and `Annotator` carry their own name.** The trace needs one, and the arrow a rule factory
returns has an empty `fn.name`. This is the one place the repo's named-parameters rule does not apply:
both stay positional, because the contract specifies that shape and it is the seam.

**The trace is required, not optional.** At six rules you already cannot answer "which rule dropped
that message?", and annotators need it.

**Preserving `providerOptions` on reasoning parts is the stream accumulator's job, not a rule's.**
`providerMetadata` arrives on `reasoning-start`, every `reasoning-delta`, and `reasoning-end` — where
Anthropic's signature actually lands — and must be written back under the request-side name
`providerOptions`. That merge is where round-trip breaks.

## Hooks

```ts
enum EStage { Guard, Policy, Observe }

type BeforeStep    = (a: Assembled) => Promise<Assembled>                    // persists
type BeforeRequest = (p: ProviderPrompt) => Promise<ProviderPrompt>          // transient, per-provider
type BeforeTool    = (args: { call: ToolCall }) => Promise<BeforeToolOutcome>
type AfterTool     = (args: { call: ToolCall; result: ToolOutcome }) => Promise<EventDraft[]>
type OnChunk       = (c: Chunk) => Promise<Chunk | null>
type AfterTurn     = (args: { branchId: string }) => Promise<EventDraft[]>

type ToolCall = { callId: string; name: string; input: unknown; effect: EToolEffect }
```

- **`BeforeStep` and `BeforeRequest` are different seams** — the first persists to the record, the
  second is a transient per-provider rewrite. Adopted from Mastra, whose split proved real.
- **`effect` is on the call.** Otherwise every guard hook injects the tool registry to learn whether
  a tool mutates.
- **Ordering is by named stage**, with a numeric nudge within a stage. Bare integers work at three
  hooks and rot at thirty, where two authors both pick 50 and an alphabetical tiebreak silently
  decides security policy. `OnChunk` order is a **security** constraint: a hook returning `null` drops
  the chunk, so redaction must precede anything that logs or persists.
- **A resolver reads `approval-answered` before `BeforeTool` runs.** Without it, resume re-fires the
  hook, it asks again, and the turn pauses forever.
- **Conflicting `BeforeTool` outcomes resolve by severity: deny > ask > allow.** Every hook is
  consulted, nobody short-circuits, and all dissenters are named so the UI can say who blocked what.
- **Input threading is order-dependent even though the verdict is not.** Any harness letting hooks
  rewrite tool input needs a stated normalisation contract — two individually-correct hooks disagreed
  about whether a path was `/var` or `/private/var` and silently killed context injection on every
  write.
- **Human-edited input is re-checked through `BeforeTool` once.** An approval returning `editedInput`
  that skips the guards is a privilege-escalation path: approve `delete_path`, redirect it to
  `/etc/hosts`, and the boundary hook never sees it.

Known gaps, accepted for now: a hook cannot fail the turn or annul a tool result, and hooks see one
call at a time rather than a batch.

## Settled: core owns its message type

`Assembled` holds **core's own** message type, not the AI SDK's `ModelMessage`, and `harness/model/`
converts. This was the leaning; it is now implemented. Swapping the model layer leaves the domain
untouched, which is the difference between model-agnostic being true and aspirational.

Three consequences worth knowing before touching it:

- **`providerOptions` is `Record<string, Record<string, JsonValue>>`, not `Record<string, unknown>`.**
  The looser form is not assignable to the SDK's provider options, so conversion would need either a
  cast or a validator — and a validator over the thinking-signature bag is precisely where the silent
  mangling this document warns about would happen. The structural form is assignable both ways with no
  cast, and `core` still inspects nothing inside it.
- **There is no `system` role on a message.** System text exists only as a `SystemBlock`. This encodes
  ai@7's prohibition in the type rather than in prose.
- **Message content is always a parts array**, never the `string` shorthand. That removes the union
  re-narrowing named above as the place a tired engineer writes `as any`.

## Environment facts

- **`streamText` does not throw on model errors** — it emits `{type:'error'}` into `fullStream`.
  Unhandled, this produces silently empty assistant turns that look like successful completions.
- **A tool declared without `execute` is what stops the SDK loop**, not `stopWhen`. Keep the stop
  condition as documentation, not as the mechanism.
- **Runtime glob discovery cannot survive `bun build --compile`** — the files are not in the bundle
  and `Bun.Glob` scans a virtual filesystem. A build-time generated manifest is required, for any DI
  choice. This is a Bun bundling fact.
- **`--minify` destroys class names**, degrading anything name-derived (audit trails, ordering
  tiebreaks, config keys). Use explicit names on decorators, or do not minify.
- `ai` **does** re-export the message types — `ModelMessage`, `SystemModelMessage`, `TextPart`,
  `ToolCallPart`, `ToolResultPart`, `AssistantContent`, `UserContent`, `ToolContent` — as of ai@7.0.78.
  It does **not** re-export `ProviderOptions` or `ReasoningPart`. `@ai-sdk/provider` covers the rest
  (`SharedV4ProviderMetadata`, `JSONValue`, `LanguageModelV4StreamPart`, `getErrorMessage`), so the
  conversion layer needs no dependency beyond what `harness` already declares.
- **`@ai-sdk/provider`'s `JSONObject` admits `undefined`; core's `JsonValue` does not.** SDK provider
  metadata is therefore not assignable to core's provider options, and the conversion strips undefined
  values recursively. This is what keeps the boundary cast-free.
- **Provider metadata must be merged two levels deep, not one.** It is
  `Record<namespace, Record<key, value>>`, so a shallow spread at the namespace level silently discards
  everything the start chunk carried in a namespace the end chunk also writes — which is exactly the
  namespace Anthropic puts the thinking signature in. Union the namespaces, then union the keys within
  each. Deeper would be wrong: a nested object under a key is one opaque provider value.
- **`streamText`'s default `onError` writes to the console**, which both duplicates a thrown error and
  corrupts a terminal renderer. Pass a no-op and surface the error chunk yourself.
- ai@7 ships its own in-band approval mechanism. Ignore it deliberately — it cannot survive process
  death — but expect the accumulator to see approval parts.

## Style

Max 300 lines per file. No comments — name things instead; the only exception is a fact external to
the repo that cannot drift, of which this document's *why* clauses are the canonical list. No
`as any`, no `@ts-ignore`. Strict TS with `noUncheckedIndexedAccess`. Named parameters for 2+
arguments. `E`-prefixed enums. Tests in a sibling `__tests__/` as `*.spec.ts`, run with `bun test`.
