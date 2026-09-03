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
type EventEnvelope = { id: string; seq: number; threadId: string
                       runId: string; parentRunId?: string; depth: number; at: string }
type EventDraft = EventBody                      // what callers and hooks author
type Event = EventBody & EventEnvelope           // what the log returns
```

Only the log assigns `id`/`seq`/`at` — `seq` is its core invariant. **Hooks return
`EventDraft[]`, never `Event[]`**; both the core-loop and hooks-di spikes hit this independently.

**`parentRunId` and `depth` are run provenance, not a nesting budget.** They are columns on `Event`
and they answer "which run caused this one", which is what makes a tool result stampable with the run
that emitted its call rather than the run that settled it. They do not gate recursion: a sub-agent's
depth is capped at one by the tool registry it is handed, not by a counter read off the envelope.

```ts
type EventBody =
  | { type: 'user-said';          text: string; via?: EMessageOrigin }
  | { type: 'assistant-said';     parts: AssistantPart[]; interrupted?: boolean }
  | { type: 'tool-called';        callId: string; name: string; input: unknown; ordinal: number }
  | { type: 'tool-result';        callId: string; name: string; output: unknown
                                  modelText?: string
                                  error?: { message: string }; snapshotId?: string }
  | { type: 'tool-denied';        callId: string; name: string; reason: string }
  | { type: 'approval-requested'; callId: string; reason: string }
  | { type: 'approval-answered';  callId: string; decision: EDecision; editedInput?: unknown }
  | { type: 'context-loaded';     slot: string; key: string; content: string; triggeredBy?: string }
  | { type: 'nudge';              text: string; lifetimeSteps: number }
  | { type: 'background-shell-ended'
                                  shellId: string; command: string; description?: string
                                  status: EShellStatus; exitCode?: number
                                  output: string
                                  droppedCharacters: number; remainingCharacters: number }
  | { type: 'agent-spawned';      agentId: string; agentType: string; intent: string
                                  mode: EAgentStart }
  | { type: 'agent-ended';        agentId: string; agentType: string; intent: string
                                  status: EAgentStatus; killedBy?: EKilledBy
                                  prose: string; turns: number; toolCalls: number }
```

- **`tool-result.error` distinguishes a crash from a denial.** *Denied* means policy said no; a
  missing file is not a denial. Without this, assembly renders a crash to the model as a successful
  JSON result.
- **`tool-result.modelText` is what the model reads; `output` is what the log and the UI read.** One
  channel where two are needed: `edit` puts a unified diff in `output`, which is what gives
  `core/diff` and the transcript's diff blocks a producer, and puts one sentence in `modelText`,
  because the model authored the change and echoing the diff back is pure token waste. Adopted from
  Claude Code, whose `ToolResult.data` is the structured domain object and whose
  `mapToolResultToToolResultBlockParam` produces a separate, usually tiny, model-facing string.
  `ToolOutcome` makes it **required** on success so no tool author defaults to dumping an internal
  shape at the model; the event keeps it optional so historical events still parse.
- **`tool-result.name` is duplicated deliberately.** The SDK requires `toolName` on a
  `ToolResultPart`, and joining back to `tool-called` for it produced an `?? 'unknown'` fallback that
  can emit a malformed prompt.
- **`tool-called.ordinal` fixes intra-step ordering.** `seq` alone across two event kinds collapses
  text → tool-call → text into (all text)(all calls).
- **`background-shell-ended` carries the output rather than a pointer to it.** A shell that outlives
  its turn has to re-enter the conversation somehow, and the two obvious shapes are both wrong: a
  `user-said` puts words in the operator's mouth and renders as their message, and a notice saying
  "read it with `shell_output`" spends a whole model step fetching bytes the harness already held.
  So the ending is its own arm, projected by `messagesFromEvents` as a `user`-role
  `<background-shell-ended>` block and rendered by the transcript as an event line. `EShellStatus`
  lives in `core/shells` for this reason: `core` owns the value unions its event bodies store.
  The delta is read when the draft is **handed over**, not when the process exits, so an ending that
  is dropped rather than delivered leaves its output where `shell_output` can still find it.
- **The two agent bodies are the whole of what a parent records about a child, and both live on the
  parent's log.** That is the rule a delegate's work is counted, never quoted, expressed as a schema:
  a child's own rows carry the child's `threadId` and never reach the parent, so the parent holds one
  spawned row, live counts on it, and one ending carrying the child's final prose. `agent-spawned`
  renders into the prompt as **nothing** — the tool result already told the model the child started,
  and a second telling is noise. `agent-ended` is turn-taking, exactly like `background-shell-ended`,
  which is what makes an ending a wake rather than an interrupt. `EAgentStatus` and `EAgentStart`
  live in `core/agents` for the same reason `EShellStatus` lives in `core/shells`: `core` owns the
  value unions its event bodies store. `EAgentStart` has one member, `Fresh`; the fork modes were
  specified and are not in the enum.
- **`agent-ended.killedBy` is shared with shells, and it is optional because it is not always
  meaningful.** It reuses `EKilledBy` rather than declaring a second enum, since "who stopped this"
  has the same answers for a child as for a process. `attributedStop` drops it on any status but
  `Stopped`, so a child that failed or finished is never described as stopped by anyone, and the
  absent case reads as an unattributed stop rather than as a lie. Without it a parent reads "was
  stopped after 4 turns", assumes it stopped the child itself or that something broke, and
  re-spawns it — which is the wrong answer to a human pressing stop. `EKilledBy.Unrecorded` is the
  member for an ending nobody witnessed, and it is named for what is provable: Atlas does not
  observe a process dying, only that no ending was written. It renders without the word "stopped"
  and without an actor, and generalises to any reconstructed ending rather than to crashes alone.
- **`user-said.via` records who said it, and defaults rather than branching.** `EMessageOrigin` has
  two members, `Operator` and `ParentAgent`, read through the single `saidBy` accessor that treats
  an absent `via` as `Operator` — so every row written before the field existed keeps its meaning
  and no consumer needs a null check. Two members and not three: a spawn brief is the parent's
  voice like any other steer, and its distinct role as the standing objective is carried by its
  position at the head of the log, not by a third origin.
- **`nudge.lifetimeSteps` replaces `ephemeral: true`**, which named a property rather than a
  behaviour and forced the core-loop spike to invent semantics that became load-bearing. The
  behaviour is counted from the log, not from a turn's step index: a nudge is rendered while fewer
  than `lifetimeSteps` `assistant-said` events follow it, so it survives the tool traffic between
  steps and expires identically on a thread reopened in another process. `messagesFromEvents`
  projects a live one as a `user`-role `<nudge>` block; the transcript renders nothing, because the
  developer did not say it. This is what `resume` appends when an interrupted reply is the last word
  — see `resumePlan` in `core/events`.
- **`history-compacted` replaces the rows it names.** It stands at the sequence the compacted range
  ended on, and the rows at or below `throughSeq` are deleted in the same transaction — `context-loaded`
  excepted, which is current content rather than history and would otherwise strip a thread's
  instructions permanently. `replaced` is stored rather than derived precisely because the rows it
  counted are gone. This is the one event that is not purely additive, and the reason is that the
  transcript must show what the model can read: scrollback past a boundary the model cannot see makes
  "why doesn't it remember that" unanswerable. The cost is that a compaction cannot be undone, which is
  why the guard refuses an unsafe range rather than trimming it.
- **`context-loaded` is the general mechanism** for anything the model sees that is not a message: a
  `CLAUDE.md` pulled in because a tool touched a directory beneath it, a skill body, MCP tool
  descriptions. `(slot, key)` names the thing; the content decides whether it is the same load.

**`append` is idempotent on `(threadId, slot, key, content)` for `context-loaded`.** Otherwise every
context-loading hook reimplements dedup, and one that forgets spams the prompt forever.

**Content is part of the identity, and that is the correction that made reloading possible.** An
earlier revision keyed on `(threadId, slot, key)` alone. The implementation of that was not an upsert
but **first-write-wins** — re-offering a key with changed content returned the original event and
discarded the new content — so a `CLAUDE.md` edited mid-session could never reach the model again on
that thread, for the life of the thread, as a mechanical fact rather than a policy choice.

Keying on content instead gives every context source the same three properties without any of them
implementing anything: re-offering unchanged content is a free no-op that leaves the prompt cache
intact, changed content appends a **new** event, and no row is ever mutated. A source can therefore
return everything it currently knows on every turn and let the log be the delta. That is what spares
Atlas the three separate transcript-scanning delta mechanisms Claude Code grew — one each for MCP
instructions, deferred tools, and agent listings, whose own comments record them as copies of each
other carrying the same bug.

**Reuse is looked up across the composed view, not the thread's own rows, and that is what keeps a
reference fork's cache alive.** A sub-agent inheriting its parent's prefix holds none of those rows itself,
so a lookup scoped to `where: { threadId }` finds nothing, treats an unchanged `CLAUDE.md` as fresh, and
appends a duplicate — the per-thread unique index does not stop it, because the child's `threadId` differs.
Nothing renders twice: `currentContextEvents` keys on `(slot, key)` without the digest and the last write
wins, so the child's copy is the one the prompt carries. The damage is subtler than a duplicate. The file
moves from the front of the conversation to the tail, so the composed prefix is no longer byte-identical to
the parent's at the position the parent's copy occupied, every cache anchor after it is dead, and the
sub-agent pays full input price for the whole inherited history — which is the one cost inheriting by
reference exists to avoid. So the lookup spans the inherited chain, an unchanged re-offer resolves to the
**parent's** event, and the child writes no row at all.

**That rule is live and correct, and nothing exercises it yet.** `EAgentStart` ships `Fresh` alone, so
no sub-agent inherits a prefix today and every child holds its own `context-loaded` rows. It is
documented here rather than deleted because it is the reason the lookup is written the way it is, and
because deleting it would guarantee the next person re-scopes the query to `where: { threadId }` and
re-earns the finding. Do not implement against it as though reference forking were reachable — see
"Compaction" in `docs/architecture.md` for why the spawn site cannot fork.

The projection renders only the **latest** event per `(slot, key)`, so a changed file supersedes
rather than accumulates, and arrives at maximum recency. `core/context/supersede.ts` owns that; the
storage-level identity lives in `harness/store/append-plan.ts`, which digests the content rather than
keying on it directly so the unique index stays narrow.

## Log

```ts
interface EventLog {
  append(args: { threadId: string; runId: string; drafts: readonly EventDraft[] }): Promise<Event[]>
  read(args: { threadId: string; upTo?: number }): Promise<Event[]>
  head(args: { threadId: string }): Promise<number>
  readOwn(args: { threadId: string; upTo?: number }): Promise<Event[]>
}
```

**`read` returns the composed view; `readOwn` returns the thread's own rows.** They are the same thing
until a thread is forked by reference, at which point the child holds no copy of the prefix it inherits
and `read` has to stitch the parent's rows up to the fork point onto the child's own. Two readers need
the difference: assembly and the transcript want the composed view, because that is the conversation;
anything reasoning about what this thread may *write* wants `readOwn`, because a child must never mutate
a row it does not own.

**Nothing that writes a thread row and event rows together is on this interface.** Both need one
transaction over two tables, so both live on `ThreadStorePort`: `fork({ from, seq, mode, title })`
next to `rewind`, and `createWithFirstEvents` for opening a thread that must not exist empty — a
sub-agent's, whose brief is the only thing making it its turn. Neither transaction extends to a
*second* thread's rows, and that boundary is deliberate rather than incidental: `retryOnWriteConflict`
re-runs the closure on `SQLITE_BUSY`, so a transaction spanning two live threads would either retry
forever against the other thread's turn or duplicate its own effect on each attempt. `forkFrom` was specified here in an earlier revision and never implemented past
a `throw`; the mode it lacked — copy for a fork the user keeps, reference for a sub-agent inheriting its
parent's context — is the whole decision, so specifying it without one was specifying nothing.

**A forked thread's sequences do not start at 1.** `Thread.head` is initialised to the fork point, so the
child's own rows begin above it and `(threadId, seq)` stays unique per thread while the composed view stays
monotonic. Every guard that bounds a target therefore bounds against the first sequence actually present,
not against zero — `rewindTarget` predates this and assumes a floor of 0, which is safe only because a
rewind target below the first row deletes nothing.

`seq` must be assigned under a per-thread unique constraint or a transaction — array length does not
survive concurrency, and background agents mean two writers.

### A row that will not decode costs one event, not the thread

Each stored row is decoded on its own. A row whose body is not JSON, whose body no longer matches
`eventBodySchema`, or whose identifier columns will not pass the branded parsers is set aside as an
unreadable row — `id`, `seq`, `threadId`, the stored `type`, and why it failed — instead of throwing
the read. One body written by an older build would otherwise make the whole thread permanently
unreadable, and the log is the authority for assembly, transcript and rewind alike.

An unreadable row carries its identifiers as plain strings, not as `EventId` and `ThreadId`. It is a
record of a row that failed validation; branding it would assert the very thing that did not hold.
It reports what the database held, unvalidated.

The fallback is deliberately not an arm of `EventBody`. That union is switched exhaustively —
assembly rules, projections, rewind targets, exchange shape, the TUI's transcript derivation — and
a row the storage layer could not parse is a storage fact, not something the domain has an opinion
about. So the split lives at the decode boundary in `harness`: decoding rows yields
`{ events, unreadable }`, `read` returns `events` for callers that only want the log, and callers
that reason about `seq` — a rewind guard above all — can ask for both, because a guard cannot refuse
a gap it cannot see.

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
  threadId: string
  step: number
  provider: { id: string; modelId: string }
  countTokens(value: Assembled): number
  previous?: Assembled
}

function assemble(args: { rules: readonly Rule[]; annotators?: readonly Annotator[]
                          ctx: RuleContext
                          onRuleFailure?: ERuleFailurePolicy }): { assembled: Assembled; trace: AssemblyTrace }

type AssemblyPipeline = { rules: readonly Rule[]; annotators: readonly Annotator[] }
```

**Rules and annotators travel as one `AssemblyPipeline`.** They are not independently chosen: an
annotator reads the shape the rules produced, so a caller holding one without the other is holding
half a decision. As two loose fields the two composition roots — `buildHarness` and the TUI's
`compose.ts` — each had to remember both, and adding the first annotator meant editing both roots.
`defaultPipeline(workspace)` is the one thing either root asks for.

**Rules are pure and synchronous.** Not for testability — because re-running a cheap pure pipeline is
free, which makes fixpoint search over assembly parameters trivial (see the budget controller). Async
would make every rewind, fork, and dry-run assembly an I/O operation. Content that must be loaded
arrives via `AfterTool` appending `context-loaded`, and a rule renders it.

**Rules do content policy. Annotators do metadata.** Cache breakpoints, provenance, and budget
accounting are not peers of content rules — every one needed an escape hatch when forced into the
`Rule` shape. Annotators run once afterwards with read access to the trace.

**`cacheBreakpoints` is the first annotator**, and it is why the seam exists. Anthropic prices a
cache read at ~0.1x input and rejects a fifth `cache_control`, so placement is a budget of four
spent deliberately: one on the **last system block** — tools render before system, so that single
marker caches tools and system together — and up to three across the conversation, the last of which
sits on the final content block so the next step reads the whole prefix back. The others are
*anchors* at absolute multiples of `CACHE_ANCHOR_STRIDE_BLOCKS` (15) content blocks. Absolute is the
load-bearing word: the log only ever grows at the end, so a position counted from the front is the
same position next step, which is what lets a later request read what an earlier one wrote. Counted
from the end they would move every step, write entries nothing ever reads, and cost the write
premium for nothing. The stride is 15 against a 20-block lookback because each breakpoint walks back
at most 20 blocks to find a prior entry: a step that appends more than 20 blocks — an assistant turn
with a dozen parallel tool calls — would otherwise silently miss and rewrite the whole conversation.

**The marker goes on a part, never on a message.** `@ai-sdk/anthropic` will fall back to the message's
`providerOptions` and mark its last content block, which is one interrupted turn away from putting
`cache_control` on a `thinking` block — not a cacheable position. The annotator picks the last
non-reasoning part itself, and marks nothing when a message has none.

**The TTLs are fixed when the annotator is constructed**, 1h for system and 5m for the conversation.
Not a default we inherited: the system prefix is the expensive, stable half and wants to survive a
human's coffee break, while a step-to-step conversation gap is well under five minutes and the 2x
write premium buys nothing there. Anthropic requires the longer-lived entry to render first, which
system does. Fixing them at construction is also what stops a mid-session flip, which would bust the
prefix it was meant to protect.

**Budget enforcement is not a rule.** It is a controller *above* the pipeline that re-runs assembly
at escalating pressure and truncates only if the whole ladder fails. In-pipeline it overshot a
1500-token budget down to 176 — discarding 92% of remaining context — because the only safe move for
a pure function is dropping a whole turn group. The controller kept 26 messages where the rule kept 7.
`core/budget/resolveBudget` is that controller: it walks a recency ladder, and measures each rung by
re-assembling a previewed event list rather than by estimating arithmetically, so what it promises is
what the next request will actually carry. It returns a recommendation — `fits`, `compact` or
`exhausted` — because producing the summary is a model call and the controller is pure.

**`compactedHistory` is the second content rule, and it only orders — it elides nothing.** Because
compaction deletes, the log the rules see already *is* what the model reads, so there is nothing to
filter. What the rule does is place the summary: it renders the deepest watermark as a user message
wrapped in a `<system-reminder>` — never a system block, which would move the cached prefix — and puts
the surviving `context-loaded` messages *ahead* of it, so the prompt reads instructions, then compacted
history, then live turns. It needed no edit to `messagesFromEvents`, which is what `AssembledMessage`
carrying provenance bought: the rule partitions on `origin.seq` without knowing how the groups were
built.

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

type HookOutcome = { additionalContext?: string; drafts?: readonly EventDraft[] }

type BeforeTurn    = (args: { threadId: string }) => Promise<HookOutcome>
type BeforeStep    = (args: { assembled: Assembled; trace: AssemblyTrace }) => Promise<Assembled>  // persists
type BeforeRequest = (p: ProviderPrompt) => Promise<ProviderPrompt>          // transient, per-provider
type BeforeTool    = (args: { call: ToolCall }) => Promise<BeforeToolOutcome>
type AfterTool     = (args: { call: ToolCall; result: ToolOutcome; signal: AbortSignal }) => Promise<HookOutcome>
type AfterShell    = (args: { threadId: string; shell: EndedShell }) => Promise<HookOutcome>  // fired by the shell registry
type OnChunk       = (c: Chunk) => Promise<Chunk | null>
type AfterTurn     = (args: { threadId: string }) => Promise<HookOutcome>
type OnThreadOpen  = (args: { threadId: string; projectDirectory: string }) => Promise<HookOutcome>  // fired by the app

type ToolCall = { callId: string; name: string; input: unknown; effect: EToolEffect }
```

- **A draft-returning hook returns `HookOutcome`, not `EventDraft[]`.** `drafts` is the old return
  value unchanged. `additionalContext` is the shorter road for the common case — a hook with something
  to *tell the model* rather than an event to record — and `hookOutcomeDrafts` in `core/hooks` renders
  it as a `context-loaded` draft with `slot` = the hook's name and `key` = `'additional-context'`.
  That is not a convenience wrapper over a free choice of event: `context-loaded` is the only body the
  prompt projection renders *and* dedupes *and* supersedes, and all three are what "here is my current
  extra context" needs. Byte-identical context reappends to nothing, changed context replaces what the
  hook said last time, and a hook can never bury the prompt under its own history. Blank context is
  dropped rather than spent on an empty `<system-reminder>`.
- **`BeforeTurn` is the mirror of `AfterTurn`** — once per turn, before the first assembly, so what it
  loads is in the prompt the turn opens with. It sits *outside* the loop rather than behind the
  awaits-a-reply check `AfterTurn` sits on the far side of, because context loaded after assembly is
  context the step never saw. The asymmetry is deliberate and cheap: `AfterTurn` gated itself to stop
  turn-taking drafts restarting the loop it closes, a hazard `BeforeTurn` does not have, and a turn
  that goes on to return `Idle` has already had its `BeforeTurn` fire — which costs nothing when the
  hook uses `additionalContext`, since identical content dedupes to the event already in the log.
- **`AfterShell` is the one phase no turn drives.** A backgrounded shell can end while the session is
  idle — that is the whole point of the idle wake — so `BunShellRegistry` invokes it from the exit
  the process reports, not `runTurn`. Two things follow. Its `HookOutcome` drafts have no turn to be
  appended to, so they ride out with the ending's own notice through `drainNotifications`, which is
  the only delivery this side of the harness can promise; an ending is therefore queued *after* its
  hooks resolve rather than beside them, under a five-second budget past which the drafts are
  forfeit — waiting on the chain is what makes a hook that never settles an ending nobody is told
  about and a session that never quits, and plugin-provided hooks will forget an `await` long before
  they throw. And a throwing hook is caught at the registry, unlike every other phase, because the
  caller underneath it is a dying process rather than a loop that could carry the failure anywhere.
  `EndedShell` is core-owned for the same reason `EShellStatus` is: the phase must not hand a `core`
  consumer a `harness` type. The chain reaches the registry as a thunk
  (`HookChainSourceToken`) — hooks resolve tools, tools resolve the registry — the same cycle break
  `ChildRunnerDepsToken` makes for the agent supervisor.
- **`OnThreadOpen` is the second phase no turn drives.** Opening a conversation runs no turn, so a
  resumed thread that sits in a worktree would otherwise leave `BeforeTurn`-fed facts — the session's
  working directory above all — stale until somebody speaks. The app fires it when a thread becomes
  the visible conversation (boot resume, `/resume`, a fresh conversation), carrying the directory the
  opened log implies. Its drafts append to that thread's log by the caller, never to a thread the
  store does not know yet: a conversation nobody has spoken in is opened by its first turn, and a
  hook's draft must not open it early.
- **Every phase is throw-isolated and time-bounded, at the chain rather than at the call site.**
  `HookChain` funnels all nine, so one budget lives in one place. A hook that throws, outlives
  `HOOK_BUDGET_MS`, or returns `undefined` is reported through `onMishap` and degrades by phase kind:
  a collect phase contributes no drafts, a transform phase passes its value through unchanged, and
  `BeforeTool` keeps its existing fail-closed `Deny` carrying the reason. `AfterShell` keeps a
  *second*, chain-wide budget on top, because N well-behaved-but-slow hooks would otherwise stretch
  teardown to N budgets. The third failure mode is the one worth naming: `BeforeStep`,
  `BeforeRequest` and `OnChunk` are pipelines whose return value replaces the thing, so a hook
  written `async () => {}` silently handed the model `undefined` or muted the stream. **`undefined`
  is not a valid return from any phase**; `null` still means "drop this chunk" and only `OnChunk`
  may say it.
- **`AfterTool` carries an `AbortSignal`.** It runs after the tool has already been aborted and it
  holds the tool-result draft, so without one a hung after-tool hook could not be freed by
  interrupting — the turn simply never proceeded.
- **`BeforeStep` and `BeforeRequest` are different seams** — the first persists to the record, the
  second is a transient per-provider rewrite. Adopted from Mastra, whose split proved real.
- **`BeforeStep` carries the assembly trace.** It runs at the one point where the trace still exists,
  and the loop previously dropped it there. Anything that must answer "which rule dropped that
  message?" or "did the cache annotator place its breakpoints?" needs it, and inventing a second
  observation seam for that would be inventing a seam this one already is.
- **`effect` is on the call.** Otherwise every guard hook injects the tool registry to learn whether
  a tool mutates.
- **Concurrency safety is on the declaration, keyed by input.** `isConcurrencySafe?(input)` is optional
  on `ToolDeclaration`, absent means unsafe, and `isConcurrencySafeCall` fails closed on an unregistered
  tool, a schema-parse failure or a throwing predicate. It is typed `(input: z.output<TSchema>) => boolean`
  on `ToolDefinition` and erased to `(input: unknown) => boolean` on `ToolDeclaration`; the erased side
  is declared with **method syntax** deliberately, because a property-syntax optional would make a
  specifically-typed implementation unassignable under `strictFunctionTypes`.
- **A Write or Destructive tool is never concurrency-safe, whatever it declares.** `isConcurrencySafeCall`
  short-circuits on effect before consulting the predicate. `dispatch` snapshots the workspace before
  such a tool runs, and a snapshot means "the tree before this call" — concurrent writers capture each
  other's partial state and rewind-to-before-this-call stops being true. Making this structural rather
  than conventional is what stops a later tool reintroducing the hazard by opting in.
- **Ordering is by named stage**, with a numeric nudge within a stage. Bare integers work at three
  hooks and rot at thirty, where two authors both pick 50 and an alphabetical tiebreak silently
  decides security policy. `OnChunk` order is a **security** constraint: a hook returning `null` drops
  the chunk, so redaction must precede anything that logs or persists.
- **A resolver reads `approval-answered` before `BeforeTool` runs.** Without it, resume re-fires the
  hook, it asks again, and the turn pauses forever.
- **Conflicting `BeforeTool` outcomes resolve by severity: deny > ask > allow.** Every hook is
  consulted, nobody short-circuits, and all dissenters are named so the UI can say who blocked what.
- **Hooks see one call at a time rather than a batch, and partitioning happens before them.** A step's
  calls are folded into concurrent runs before `dispatch`, so `isConcurrencySafe` reads the raw logged
  input, and a `BeforeTool` hook that rewrites input cannot move a call between batches. The gap this
  leaves — a guard that must reason about two calls of one step together — is closed today only by the
  effect rule above keeping every world-changing call in a batch of one.
- **A batch has no size limit.** `partitionToolCalls` takes no cap: admission is the predicate and
  nothing else. A number here would only ever bite a step the model deliberately fanned out, and the
  effect rule already means every call in a batch is read-only.
- **Input threading is order-dependent even though the verdict is not.** Any harness letting hooks
  rewrite tool input needs a stated normalisation contract — two individually-correct hooks disagreed
  about whether a path was `/var` or `/private/var` and silently killed context injection on every
  write.
- **Human-edited input is re-checked through `BeforeTool` once.** An approval returning `editedInput`
  that skips the guards is a privilege-escalation path: approve `delete_path`, redirect it to
  `/etc/hosts`, and `ReadBeforeWrite` never sees it.

Known gaps, accepted for now: a hook cannot fail the turn or annul a tool result, and hooks see one
call at a time rather than a batch.

**Implemented in slice 2.** `resolveBeforeTool` in `core/policy` is the severity resolution above:
every hook is consulted, none short-circuits, deny > ask > allow, `dissenters` names every hook that
returned Ask or Deny, and input threads sequentially so the winning Allow carries the last Allow's
input. `orderHooks` in `core/hooks` is the stage-then-nudge-then-**name** ordering; the name tiebreak
is not garnish, it is what stops two authors both picking nudge 50 and getting an ordering decided by
array-literal position. `harness/tools/dispatch.ts` is the only caller of either. It is now the `ToolDispatcher` port with a
`HookedToolDispatcher` adapter, and it dispatches `BeforeTool` and `AfterTool`. The remaining phases
are wired elsewhere rather than unwired: `harness/hooks/registry.ts` is a `HookChain` class whose
`beforeTurn`, `beforeStep`, `beforeRequest`, `onChunk` and `afterTurn` methods are called by
`LoopTurnRunner` and `AiSdkModelPort`, and its `afterShell` method by `BunShellRegistry`.

**`dissenters` is computed and currently discarded.** `tool-denied` carries only `reason`, so the
"UI can say who blocked what" purpose is unmet until that event grows a field. Recorded so it reads
as a known gap rather than an oversight.

**Read before write is a guard hook plus a recorder, and `AfterTool` has a producer at last.**
`ReadBeforeWriteHook` (`EStage.Guard`, nudge 1) denies a write to a file with no recorded view, one whose `mtimeMs` or `size` no
longer match disk, or — for a whole-file replace only — one where the model saw a window. A path that
does not exist is allowed: creating a file destroys nothing, and refusing it would make `write` to a new
path and `edit` with an empty `oldString` impossible. `RecordFileStateHook` (`EStage.Observe`) fills
the notebook after a successful call and is the **first registration of `AfterToolHook`** in the repo.

**Which tools this applies to is declared, never inferred.** `DeclaredPathField.content` is an
`EContentAccess` of `None | Reads | Amends | Overwrites`. `EToolEffect` cannot answer it: it
over-selects, since a future `mkdir` or `move` is `Write` and must not demand a prior read, and
`grep`/`glob` are `Read` while showing only fragments. `Amends` and `Overwrites` are separate members
because their safe preconditions differ — `edit` matches `oldString` against freshly read bytes and
fails if absent or ambiguous, so its blast radius is bounded by a string the model provably saw, while
`write` replaces every byte and gets no such bound. Collapsing them into one value forces the guard to
branch on `call.name`, which is the table `pathFields` exists to have deleted.

**Whether a read showed the whole file is answered by the tool, not read off its input.**
`ToolDeclaration.revealsWholeFile?({ input, output })` is optional and defaults, at the call site, to
`false`. A guard reading `offset`/`limit` field names itself would silently credit a future reader
using `startLine`/`maxLines` with a whole-file view, which is the same fail-open one step along. The
predicate may **under-claim** and must never **over-claim**: a generous `limit` that happened to return
everything reads as a window, so the model re-reads. That direction is free; the other destroys files.

It is handed the **outcome** and not only the input because a read can be cut short by something the
input never mentioned. `read` caps itself at 2000 lines and clips each line at 2000 characters, so an
input carrying neither `offset` nor `limit` is no longer evidence that the whole file came back — only
`output.truncated` is. An input-only predicate was sound while a bare read was all-or-nothing; adding a
default cap is exactly the change that turns it into an over-claim, and an over-claim here lets `write`
replace a file the model has seen the first 2000 lines of.

**A guard that cannot verify must deny.** `stat(path).catch(() => null)` collapses "absent" and "not
permitted to look" into one value, making a guard strongest against the benign case and weakest against
the suspicious one. The read-before-write gate distinguishes three states: absent allows, present
continues, and unverifiable denies while naming the errno.

**Tool input is validated twice, and neither is redundant.** `dispatch` parses `call.input` against
the declaration's schema *before* the `BeforeTool` chain, which turns a malformed call into one
correctable `tool-result` and means a guard hook never does input archaeology. Each tool re-parses
inside `invoke`, which is **structurally forced**: `ToolInvocation.input` is `unknown`, so parsing is
the only route to typed input without a cast, and what reaches `invoke` is `outcome.input` from the
winning Allow — the post-hook value dispatch never saw. So dispatch validates what the *model* sent
and the tool validates what the *hooks* produced.

**The AI SDK validates too, and its verdict is discarded.** `doParseToolCall` in `ai@7` parses the
model's arguments against the declared schema and throws `InvalidToolInputError`, but
`parseToolCall`'s outer catch swallows it and emits a normal `tool-call` part carrying
`invalid: true`, `error`, and the raw input — or the raw *string*, when the arguments were not valid
JSON. `harness/model/chunk-conversion.ts` then maps the valid and invalid branches identically. So
Atlas's parse is not the first validation, it is the first **enforcement**, and the SDK is not a line
of defence to lean on while discarding its output. Carrying `invalid`/`error` through `Chunk` would
fail the call at the boundary instead of re-deriving the verdict; `repairToolCall` is also available
and unset.

## The assembled exchange is checked before it is sent

`exchangeFaults(assembled): readonly ExchangeFault[]` in `core/assembly` reports the shapes the
provider rejects. Empty means well-formed. Each fault carries the offending `messageIndex`, a
`detail`, and the `origin` `EventRef` — so a rejection names the log event that produced it rather
than a prompt position. `runTurn` calls it between `assemble` and the model step and fails the turn
on any fault, because the request would be rejected anyway and a named fault beats an opaque 400 one
round trip later.

**The contract is deliberately narrow: every fault is a request Atlas must not send.** That is what
makes it safe to wire to a refusal, and it is why `toolName` mismatch between a result and its call
is *not* checked — a genuine projection bug that will corrupt the TUI, but neither a rejection nor a
request with a meaning Atlas did not intend.

Almost every member of that set is there because **the provider will reject it**, which is the
stronger and more obvious reason. `EndsWithAssistant` is the one member that is not: Anthropic
supports assistant prefill on some models, so a trailing assistant message is a rejection on the
models Atlas uses and a feature elsewhere. It belongs here because Atlas has no prefill: the loop
assembles only when the conversation is the user's to answer, so a prompt ending on the assistant is
a projection disagreeing with the loop's own gate, and sending it asks for a completion nobody meant
to request. It is the false-positive question, not the rejection question, that decides membership —
and this check cannot fire on a legitimate turn, because there is no legitimate turn it describes.
**If Atlas ever gains a deliberate prefill — "continue this response" — this fault must be gated on
that intent rather than left standing.**

It was written against `@ai-sdk/anthropic`'s own converter, which corrected two invariants that
looked obvious and were wrong:

- **`groupIntoBlocks` maps a `tool` message into a `user` block**, and consecutive `user`/`tool`
  messages append to the same open block. The provider never sees our message list; it sees merged
  turns. So "no `tool` message except directly after an assistant turn" is a false positive —
  `assistant[c0,c1] / tool[r0] / tool[r1]` merges into one accepted turn. The real property is that
  within a merged turn no `tool_result` may follow a non-result part, which is why Anthropic requires
  results at the beginning of a turn.
- **`moveToolUseBlocksToEnd` hoists `tool_use` after text within an assistant message**, so
  `assistant[call, text]` is provider-repaired and must **not** be flagged. There is a passing test
  pinning that non-check so nobody adds it later.

### Known gaps, and the division they share

A fault that is not certain is worse than a missing one, because the loop refuses the step on it. So
the validator declines to guess, and these stay unchecked:

1. **A whitespace-only text part.** An *empty* text block is rejected; whether a whitespace-only one
   is, is unverified. This was briefly checked as `text.trim() === ''` and it hard-failed ordinary
   turns — Claude commonly emits a whitespace-only text block after a thinking block — so it is now
   `text === ''` only.
2. **Reasoning parts replayed without a signature.** Provider-opaque; `core` cannot know what a valid
   signature looks like. This is a shape the validator does not fault and the provider *does* reject,
   and it is the only one known.
3. **`ToolCallPart.input` that is not JSON-serialisable.** A real 400 class, but proving it needs the
   `unknown`-to-`JsonValue` validator this document refuses to invent.
4. **`toolName` disagreeing between a result and its call.** A genuine projection bug that will
   corrupt the TUI, but not a provider rejection, so checking it here would break the contract that
   makes the module safe to wire to a refusal.
5. **Result order within a turn.** Anthropic keys on `tool_use_id`, not position; checking order would
   reject working prompts.
6. **Token budget, message count, empty `system`, alternation past the first message.** Not
   structural, or repaired by the provider's block merging.

Gaps 1 and 2 share a shape worth stating once: the **producer** emits something questionable and the
validator declines to guess. That is the intended division of labour. The accumulator should not create
shapes that never made sense — it now drops empty and whitespace-only text parts at the source — and
the validator asserts only what is certain. Every gap on this list resolves at the producer, not by
loosening the check.

**Its closing counterpart is live, and was written from a failure in the field.** Appending a steer
the moment it was typed gave it a lower `seq` than the `assistant-said` appended once the step
finished, so the projection emitted `user / user / assistant` and the provider answered
`This model does not support assistant message prefill`. The loop now drains queued messages at the
boundary before assembling, which orders them correctly by construction; `EndsWithAssistant` is what
catches the next way in.

**One fault is latent rather than live.** `OpensWithAssistant` is unreachable today, because `say`
always appends `user-said` first and a log of only `assistant-said` makes `awaitsReply` false. It
becomes reachable when `forkFrom` lands, which makes it a constraint on the rewind slice: **a fork
point must never leave a thread whose first event is `assistant-said` or `tool-called`.**

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
