# Mastra spike findings

Source: `.spikes/mastra/` (gitignored). 18 passing tests, `tsc --noEmit` clean. Versions exercised:
`@mastra/core@1.61.0`, `ai@7.0.77`, `bun@1.3.14`, `@mastra/libsql@1.21.1`. Recorded 2026-08-24.

**Recommendation: reject Mastra as a framework. Adopt two of its designs.**

## The fear did not materialise — record this

The stated worry was that Mastra owns `MastraDBMessage`, memory, and storage, so adopting it means
surrendering the event log as the record. **That is disproven.**

- **Boots under Bun with no shims.**
- **Memory is fully removable.** `memory` is optional on `AgentConfig`; omit it and `hasOwnMemory()`
  is false, no threads written.
- **`processInputStep` accepts a fully externally-supplied message list every step.** At step 1 of a
  tool loop, Mastra's own threaded state held the assistant tool-invocation and its result, while the
  prompt actually delivered to the model contained only what our log derived.
- **It controls all three dimensions**: messages, system block (it *replaces* agent-level
  `instructions` rather than merging), and — importantly — **reasoning `providerOptions` survives the
  round-trip verbatim**, signature intact.
- **PostHog telemetry is moot.** Opt-out exists via `MASTRA_TELEMETRY_DISABLED`, its only caller is
  server startup, zero outbound fetch during a run, and `posthog-node` tree-shakes out entirely.
- **Storage writes nothing on the happy path**, though it cannot be removed — an ephemeral
  `InMemoryStore` is constructed silently if you pass no `Mastra` instance.

One hard constraint, thrown rather than documented: a processor must **mutate the passed
`messageList`** (`removeByIds` then `add`) — returning a fresh instance throws.

## Where the collision actually is

Not in the messages. In **loop position**.

`agent.approveToolCall({ runId })` does not re-derive anything — it reloads a serialized
`agentic-loop` workflow snapshot from Mastra storage, keyed by `runId`. So adopting Mastra means
running **two records of the same run**: our event log for messages, and Mastra's opaque workflow
snapshot for position, which we do not author, cannot rewind, and cannot fork.

Resume *does* survive a real process kill — proven with two separate `bun` processes, A suspending on
an approval-gated tool and exiting, B approving cold and completing. But it cost two things:

- **A standalone `Agent` suspends and can never be resumed** — `approveToolCall` throws
  `AGENT_RESUME_NO_SNAPSHOT_FOUND`. It must be registered on a `Mastra` instance with storage.
- **`@mastra/core` ships no durable workflow store.** Its own `FilesystemStore` does not implement
  the `workflows` domain at all.

Fork works, and **Mastra contributes nothing to it**. There is no conversation-fork API; `__fork()`
clones agent config for the editor, and workflow time-travel targets user workflows, not the internal
`agentic-loop`. Fork happens entirely at our layer — and works only because the record is ours.

## Compilation

`bun build --compile` succeeds. The three dependencies flagged as risks — `execa`, `ws`,
`xxhash-wasm` — all bundle cleanly; none was a problem.

**The landmine is `@mastra/libsql`**, the obvious durable store: `Cannot find module
'@libsql/darwin-arm64'` — a native `.node` addon cannot be embedded. Workaround is cheap:
`WorkflowsStorage` is a 9-method abstract class, reimplemented over `bun:sqlite` in **100 lines**,
after which the whole kill/resume path works from source and compiled.

## What it costs

| | baseline (`ai` only) | with `@mastra/core` |
| --- | --- | --- |
| bundled JS | 0.59 MB | 9.25 MB (**15.7×**) |
| `node_modules` | — | 136 MB, 159 packages (70 MB is `@mastra/core`) |
| compiled binary | 61 MB | 69 MB |
| modules bundled | 100 | 652 |

Used: the `Processor` pipeline and the approval suspend machinery — **~10–15%**. Disabled or ignored:
memory, `MastraDBMessage` as record, threads, 23 of 24 storage domains, skills, workspaces, MCP, A2A,
browser, voice, TTS, evals, networks, sub-agents, editor, schedules, channels, deployer.

Plus three vendored copies of `@ai-sdk/provider-utils` (v5/v6/v7) funnelling through a
`LanguageModelV2`-shaped internal bottleneck, `providerOptions.mastra.createdAt` written into every
content part and reaching the wire, and the standing risk that a library designed around owning
conversation state changes the one hook we depend on.

## Why this is decisive

The proof that the event log can stay canonical required: disabling memory, replacing the message
list every step, overriding the system block, mutating a `MessageList` in place because a fresh
instance throws, and hand-writing a storage adapter to keep `--compile` viable — and still ends with
a second, un-forkable record of loop position.

The hand-rolled spike got resume **free**, because position is a pure function of the log. One
record, and rewind and fork fall out of it. Mastra charges 9 MB, a second record, and a 100-line
custom store for a resume that is strictly weaker.

## Adopt these two designs

1. **The `processInputStep` / `processLLMRequest` split.** Mutations in the first persist to the
   message list; the second is transient, per-provider, and does not persist. Our contract's
   `BeforeStep` conflates the two, and the distinction is real.
2. **The approval suspend contract.** A JSON-schema'd `{ approved: boolean, reason?: string }`
   returned by `runId` maps cleanly onto `approval-requested` / `approval-answered`. Take the shape,
   not the machinery.

## The principle worth protecting

Whichever engine is chosen: if the checkpoint and the event log are two records of the same run,
keeping them from drifting on rewind is ongoing work. One record avoids it entirely. That property
is the thing to protect in whatever gets built.
