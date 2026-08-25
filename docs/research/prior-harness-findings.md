# Evidence from the prior harness and the AI SDK

Gathered 2026-08-24 while charting the skeleton. This file records **findings, not decisions**.
Decisions live in the wayfinder map once ratified.

Source for the prior harness: Atlas commit `f82a7488^` (the v1 harness was deleted in `f82a7488`,
"Remove v1 harness system — atlas v2 is the sole orchestrator"). It is not in any working tree —
read it with `git show f82a7488^:backend/src/harness/bot-graph/<file>`.

## The prior harness ran LangGraph in earnest

`@langchain/langgraph@^1.3.6`, `@langchain/core@1.1.48`, with a real `PostgresSaver` checkpointer
injected through NestJS DI (`@Inject(CHECKPOINTER)`), threaded on `${bot.id}:${channelId}:root`.

```
START → gate ─(route)→ recall → llm ⇄ tools → tool_loop_guard → refreshContext ─┐
              └→ consume → END        └──────── llm (revision self-edge) ←──────┘
                                      reconcile → compact → END
```

Nine nodes, bound off an injected nodes service. LangGraph + Nest DI + a durable checkpointer is
therefore proven ground, not a new bet.

## `messages` was inside graph state

`bot-state.ts` declares it as the first channel of `Annotation.Root`, with `messagesStateReducer`,
commented "the bot's persisted conversation (the real, durable history)."

Six further channels exist for one purpose — put something in front of the model without putting it
in `messages`:

| Channel | Its own comment |
| --- | --- |
| `recalled` | "Re-injected each llm call like the persona, NEVER written into `messages`" |
| `context` (4 slices) | rendered by `renderContext()` into every call |
| `memorySuggestions` | "injected into the context so the agent sees and acts on it" |
| `draft` | "NEVER enters `messages`: durable history records only what was actually said" |
| `toolLoopInstruction` | "NEVER persisted into `messages`… cleared by `llmNode` after it renders" |
| `relaySeed` | "NEVER appended into `messages`… mirrors `draft` / `toolLoopInstruction`" |

`relaySeed`'s comment names the duplication outright. This is a context-assembly pipeline
discovered incrementally and implemented six times, each with a hand-managed lifetime.

### Three costs, all visible in the file

**A field that cannot be deleted.** `summary` is `@deprecated` with: "Read-only compat shim:
checkpoints that carry a `summary` string are deserialized into this field… remove once all active
threads have cycled through at least one new compaction pass." Derived state in a checkpoint turns
a refactor into a data migration you wait out.

**Defaults do not re-apply.** Seven channels carry "reset by `gate` each run (Annotation defaults
don't re-apply on an existing checkpoint thread)." Every ephemeral field needs manual reset; miss
one and state leaks across turns.

**Compaction is an index into a mutable array.** `summarizedUpTo` is a `messages[]` offset held in
the checkpoint. Rewind or fork invalidates it.

## Steering worked at step boundaries only

`bot-graph.mid-turn.spec.ts`: "THE HEART of the harness — mid-thought collaboration. The `llm` node
consumes `channel.since(cursor)` at the TOP of EVERY step, so a message that lands WHILE the bot is
looping through tools is folded into its very next model call."

No abort, no `interrupt()` — a cursor in graph state, drained at each step. It cannot catch a
message arriving mid-`model.invoke`, which is why `draft` and the read-the-room revision loop
(512 lines of spec, and the `llm → llm` self-edge) exist. That gap is the "mid-flight was a little
weird" recollection, and it is inherent to boundary-only steering rather than to LangGraph.

## AI SDK facts (verified against `ai@7.0.77`, `@ai-sdk/anthropic@4.0.41`)

Installed into a scratchpad and read from `node_modules`, not from memory.

- **`@ai-sdk/provider` is separately installable** (`4.0.7`). Own model implementations need only
  the types package.
- **`LanguageModelV2`, `V3`, and `V4` all ship side by side.** V3 is already superseded; V4 adds
  `reasoning-file` and `CustomPart`.
- **Reasoning signatures are not first-class.** `LanguageModelV3ReasoningPart` is
  `{ type: 'reasoning'; text: string; providerOptions?: SharedV3ProviderOptions }`. The Anthropic
  provider recovers the signature from metadata (`signature: reasoningMetadata.signature`) and
  handles `redacted_thinking` and `signature_delta`.

  > **Constraint on any assembly rule:** rebuilding or rewriting messages must preserve
  > `providerOptions` on reasoning parts, or Anthropic thinking round-trip breaks silently.

- **Cache breakpoints are precise.** `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`
  per message or per part, `ttl: '1h'` supported.

### Anthropic ships server-side context management

Exposed through `providerOptions.anthropic.contextManagement.edits`; what was actually cleared comes
back in `providerMetadata.anthropic.contextManagement`.

| Edit type | Effect |
| --- | --- |
| `clear_thinking_20251015` | `keep: { type: 'thinking_turns', value: N }` — keeps only the N most recent thinking turns |
| `clear_tool_uses_20250919` | drops old tool call/result pairs; `keep`, `clearAtLeast`, `clearToolInputs`, `excludeTools` |
| `compact_20260112` | summarizes earlier context when token limits are reached |

The first row is the "tail the last 10–20 thinking blocks" requirement, already implemented
server-side. The third is what the prior harness hand-built as `summaries` + `summarizedUpTo` +
`compactionVersion` + the undeletable `summary`.

Caveats: Anthropic-only, so a model-agnostic pipeline is still required for the Codex/OpenAI path;
clearing happens server-side, so what was dropped is learned after the fact; it operates on what is
sent, so it composes with derived context rather than replacing it.

Implication: an assembly rule should be able to declare a **provider-native fast path** with a
fallback to our own implementation.

## `HarnessAgent` is the path being rejected

`ai@7` ships an experimental harness abstraction (`HarnessAgent`, `@ai-sdk/harness-claude-code`)
that wraps Claude Code and Codex with sandboxing and permissions — i.e. what Atlas already is. Its
own docs point elsewhere for this project: "Use providers and models when you want direct control
over the model call, the tool loop, model settings, structured output, or a custom agent
architecture."

Recorded as the deliberate off-ramp, not as a candidate.

## Open thread: one datastore

LangGraph's checkpointer interface is small. Implementing it over the same Prisma/SQLite database
would keep a single datastore and one migration story, making the checkpoint a table we own rather
than a second persistence model. Unverified — the interface has not been read yet.
