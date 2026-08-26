# Atlas architecture

Authoritative. Where the code disagrees about *mechanism*, the code wins; where it disagrees about
*intent*, change the code. Every load-bearing claim here was established by a spike, not by argument
— evidence in `docs/research/`, seams in `docs/core-contract.md`.

## What Atlas is

A coding-agent harness in the shape of Claude Code. The agentic loop is ours: we make raw model calls
and own every decision the loop makes — what context the model sees, which tools may run, when a
human is asked, what happens on rewind. Because the calls are raw, Atlas is model-agnostic by
construction; Claude and Codex subscription credentials are one provider implementation, not a
foundation.

## The two rules

**1. The model never sees stored state. It sees a projection built fresh for every step.**

```
EventLog (append-only, canonical) → assemble(rules) → annotate → Assembled → one model step
```

There is no accumulating `messages[]` anywhere. Thinking-block tailing, context injection, image
downgrading, compaction, redaction, token budgeting, rewind, fork, and steering are all the same
mechanism: a rule over the log.

**2. One record.**

If a checkpoint and the log are two records of the same run, keeping them from drifting on rewind is
permanent work. This is the whole reason no graph framework is used. LangGraph's checkpointer and
Mastra's `agentic-loop` snapshot are each a second, un-forkable record of loop position — and the
event log already provides durable resume, so it would be bought twice.

## The loop

```ts
async function runTurn({ branchId, signal }: { branchId: string; signal: AbortSignal }) {
  let modelSteps = 0
  while (modelSteps < maxSteps) {
    const events = await log.read({ branchId })

    const waiting = outstandingApproval(events)
    if (waiting) return { status: Paused, callId: waiting }

    if (pendingCalls(events).length > 0) {
      const settled = await settlePending({ branchId, signal })
      if (settled.paused) return settled.paused
      continue
    }

    const assembled = await hooks.beforeStep(assemble({ events, rules, annotators, ctx }))

    const faults = exchangeFaults(assembled)
    if (faults.length > 0) return { status: Failed, message: report(faults) }

    modelSteps += 1
    const { parts, toolCalls } = await modelStep({ assembled, tools, signal })

    if (parts.length > 0) await log.append({ branchId, drafts: [{ type: 'assistant-said', parts }] })
    for (const [ordinal, call] of toolCalls.entries()) {
      await log.append({ branchId, drafts: [{ type: 'tool-called', ordinal, ...call }] })
    }
    if (toolCalls.length > 0) continue

    await log.append({ branchId, drafts: await hooks.afterTurn({ branchId }) })
    return { status: Completed }
  }
  return { status: Exhausted }
}

const resume = runTurn
```

**`maxSteps` counts model steps, not loop iterations.** A settlement is work the harness does between
model calls, so charging it against the ceiling made the advertised budget depend on whether the model
happened to use tools — halving it for a coding agent, which uses them constantly. A separate
iteration backstop remains, as a spin guard rather than a budget. `ctx.step` handed to rules is the
model-step index for the same reason: `nudge.lifetimeSteps` is specified in model steps.

**`settlePending` is built by the loop, not injected into it.** `TurnDeps` takes `dispatch`; the loop
constructs `settlePending` from `dispatch` and the log it already holds. Injecting a pre-built
`settlePending` meant it closed over a *different* log than the loop wrote through — two logs writing
one branch in a single turn, which the delta-publishing wrapper makes reachable. Absent `dispatch`,
the loop pauses on a pending call exactly as it did before tools existed, which is what a subagent
given no tools needs.

**Tool results are stamped with the run that emitted the call**, not the run that settles it. That is
what makes a turn which paused and resumed produce a log identical to one that completed in a single
pass — the property the whole event-log design exists to protect.

**Resume is not implemented.** `resume` *is* `runTurn`, because position is a pure function of the
log. Proven by serializing the log, discarding every in-memory object, rebuilding with a different
model script, and completing the turn. A durable pause is `return`.

**A sub-agent is this function called recursively** with different arguments — tools, policy, budget,
branch. Nothing per-run belongs in the DI container; wanting a child container is a smell that
run-varying config got injected instead of passed. Every event carries `runId`, `parentRunId`, and
`depth` so nesting is never foreclosed.

## Three timelines

| Timeline | Owner | Restored by |
| --- | --- | --- |
| **Conversation** — messages, reasoning, tool calls, approvals | EventLog (SQLite) | move the branch head |
| **Control** — pending tool, retries, interrupt reason | *derived from the log* | re-read the log |
| **World** — files, git index, worktree, subprocesses | Workspace snapshots (git objects) | restore the snapshot on the event |

The middle row is where frameworks want to sell you a checkpointer. We don't have one because we
don't need one.

`rewind(eventId)` resolves the event's `snapshotId`, restores the workspace, and moves the branch
head. Fork is the same operation writing to a new `branchId` — one row, because context is derived.

Snapshots cannot undo non-filesystem effects, so tool dispatch takes
`idempotencyKey: ${runId}:${callId}`.

## Durable events vs streaming

Durable events are **coarse** — one `assistant-said` per model step, not one per delta. Writing every
token to SQLite is absurd.

Live streaming goes to an in-memory channel the UI subscribes to, replaced by the durable event when
the step completes. So the UI has two inputs: the log (history, authoritative) and the delta channel
(the current step, ephemeral). `OnChunk` hooks run on the channel — which is why redaction ordering
there is a security constraint, not a preference.

## Packages

```
atlas/
  packages/
    core/       pure. no I/O, no clock, no randomness, no network, no database
    harness/    the loop, hooks, tools, model adapters, credentials, store
  apps/
    tui/        OpenTUI + React, and the composition root
  docs/
  deprecated/   frozen reference: the previous TUI, the never-run agent-engine and the codex-sdk
                client, and the paused backend/web/shared cloud stack with its CI and infra
  .spikes/      four reference implementations (gitignored)
```

`deprecated/` is not a Bun workspace member. It is read for prior art and never imported.

`core` performs **no I/O**. When something is hard to test, that is the signal to move the decision
into `core`, not to add a mock. `tui` never imports `store` or `providers` directly — it talks to
`harness` through its ports, and the composition root is the only place that knows which
implementation is bound.

Three packages, not five. A package boundary is worth it only where the compiler should enforce a
dependency rule: `core` has no I/O, `harness` is importable without a terminal. `store` and
`providers` stay folders until something forces them out.

### Folder structure

```
packages/core/src/
  events/        Event union, EventDraft, envelope, branded ids
  events/        projections: pendingCalls, outstandingApproval, answeredApproval
  assembly/      Assembled, Rule, Annotator, RuleContext, assemble, trace
  assembly/      exchange-shape: the faults a provider would reject, reported not thrown
  assembly/rules/        content policy — thinking tail, loaded context, ephemeral, images
  assembly/annotators/   cache breakpoints, provenance
  budget/        the fixpoint controller (pure: takes a rebuild function)
  hooks/         phase types and outcome types only — no container
  policy/        BeforeTool severity resolution, the approval resolver
  tools/         ToolCall, ToolOutcome, EToolEffect, definition types
  ports/         EventLogPort, ModelPort, WorkspacePort, CredentialPort, ClockPort, IdPort,
                 SettingsStorePort
  settings/      definitions, layered resolution with provenance, edit operations, the registry
  message/       Atlas's own message type (see below)

packages/harness/src/
  loop/          runTurn, settlePending
  model/         ModelPort over AI SDK; the stream accumulator
  model/providers/   LanguageModelV4 impls: claude-oauth, codex-oauth, api-key
  credentials/   CredentialPort backends: macOS Keychain, auth.json file, encrypted vault
  store/         Prisma event log, branch heads, workspace snapshots
  tools/         registry, dispatcher, builtin tools
  hooks/         hook implementations — claude-md injection, workspace boundary, approval policy
  settings/      SettingsStorePort backends: user and project files, in memory; the layer service
  workspace/     git snapshot and restore
  discovery/     glob at dev time, generated manifest for --compile

apps/tui/src/
  main.tsx
  composition/   the container bootstrap — the only place bindings are chosen
  store/         ConversationStore: log + delta channel → useSyncExternalStore
  ui/            components, pages
  ui/markdown/            segmenter, prose, tables, fenced blocks; the renderer registry
  ui/markdown/renderers/  one FencedRenderer per fence kind: diff, lexical, code, plain
  ui/markdown/grammars/   tier-1 highlighting: parsers-config.json, vendored wasm, generated loader
  ui/markdown/lexical/    tier-2 highlighting: the scanner, the rule primitives, one spec per language
  ui/markdown/themes/     capture name → semantic role → colour, for both tiers
```

Max 300 lines per file. Tests in a sibling `__tests__/` as `*.spec.ts`.

## Decisions

| Concern | Decision |
| --- | --- |
| Loop substrate | **Hand-rolled.** No LangGraph, no Mastra |
| Canonical record | Append-only event log — `messages[]` with types |
| Prompt | Derived per step by `assemble`; never accumulated |
| Checkpoints | None. Position is derived |
| Storage | Prisma 7 + `prisma-adapter-bun-sqlite` |
| Model layer | AI SDK, `streamText` one step, as normalization only |
| Provider interface | `LanguageModelV4` |
| Context operations | Ours, model-agnostic |
| DI | **tsyringe.** Class tokens, `@injectAll` for the hook and tool sets — see `.scratch/tsyringe-di/spec.md` |
| Hook discovery | Glob at dev time, generated manifest for `--compile` |
| Packages | `core`, `harness`, `apps/tui` — raw TS source, no build step |
| Runtime | Bun — runtime, package manager and test runner |
| Task runner | **Turborepo.** `turbo run typecheck \| test \| build`; per-package scripts stay `tsc` / `bun test` |
| Fenced-code highlighting | **Two tiers.** tree-sitter wasm where a small maintainer build exists; a declarative lexer for the long tail |

**`core` owns its own message type.** `Assembled` cannot hold `ModelMessage` without `core` depending
on the AI SDK, which would make model-agnosticism aspirational rather than real — and AI SDK ships
V2/V3/V4 simultaneously, so `core` would churn on their versioning. The type is deliberately *thin*
and structurally close to `ModelMessage`, with
`providerOptions: Record<string, Record<string, JsonValue>>` passed through opaquely, so conversion in
`harness/model/` is near-identity and no provider capability needs modelling in `core`. The nesting is
load-bearing rather than incidental: a flat `Record<string, unknown>` is not assignable to the SDK's
provider options, so conversion would need a cast or a validator, and it leaves the metadata merge
ill-defined at exactly the depth where the signature lives. **That passthrough must never be dropped** — Anthropic thinking signatures ride
in it, and losing them fails silently.

**Syntax highlighting is two tiers, and the tiers must not overlap.** A tree-sitter language costs
0.2–3.3 MB of `.wasm`, committed and embedded in `bin/atlas` by `bun build --compile`. That price is
worth paying where a parse tells you something a token stream cannot — which type a name refers to,
whether `<T>` opens a generic or a JSX element. It is not worth paying forty more times for languages
whose highlighting is entirely lexical, and for most of them the question is moot: their maintainers
publish no `.wasm` at all.

So `apps/tui/src/ui/markdown/lexical/` holds a second highlighter — a pure single-pass scanner over a
declarative `LanguageSpec` of comment forms, string forms, keyword sets and an identifier alphabet,
about a kilobyte of source per language. It is not a fallback for tier 1's failures; it is the right
answer for a token-shaped language.

The seam that makes this cheap already existed. A tree-sitter highlight pass returns
`[start, end, captureName]` triples and the theme maps `captureName` to a colour, so the lexer emits
the same triples under the same nvim-treesitter names and inherits every theme unchanged. Adding a
theme still means editing one file. `lexicalRenderer` is registered ahead of `codeRenderer` in the
fenced-renderer registry, because the code renderable claims every non-empty language; a test in
`lexical/__tests__/registry.spec.ts` holds the two language sets disjoint so a lexical spec can never
silently outrank a real grammar.

The lexer is also synchronous, which the tree-sitter path is not. A `CodeRenderable` clears to plain
text and paints its highlight a worker round trip later, so a streaming fence flashes; a lexical fence
has no round trip to wait for.

## Adopted from the rejected options

- Mastra's `BeforeStep` / `BeforeRequest` split — the first persists to the record, the second is a
  transient per-provider rewrite. Our contract had conflated them.
- Mastra's approval-suspend payload shape.
- LangGraph's hard lesson: nothing derivable goes in durable state. Its predecessor in this codebase
  had a `@deprecated` field it could not delete because live checkpoints contained it.

## Why tsyringe and not Nest

The extension domain is **sets** — hooks per phase, tools in a registry — and tsyringe has `@injectAll`
as a primitive. Nest has no multi-provider, so a set is emulated with
`{ provide: HOOKS, useFactory: (...i) => i, inject: classes }`: untyped, order-coupled, and edited once
per set member, which is exactly the one-file property the hooks spike was measuring. Module
encapsulation would redraw a boundary `core` / `harness` / `apps/tui` and their barrels already enforce.
And Nest's optional peers do not bundle — `bun build --compile` needs eight `--external` flags, and each
upgrade can add another.

Startup cost is not the argument. The spike measured ~50 ms for the Nest import, and Atlas is a
long-lived process that amortises it away.

What Nest would have given us is ordered teardown. tsyringe has no lifecycle at all, so disposal is an
explicit registry the composition root owns.

**Ports are `abstract class`, not `interface`,** so the token *is* the contract — no symbol table, no
stringly-typed `@inject`. `core` therefore emits runtime values, which costs it nothing: still zero
dependencies, still no I/O.

**The one async edge stays outside the container.** `container.resolve()` is synchronous and tsyringe
has no async provider. The graph has exactly one await — `openAtlasDatabase` in
`harness/loop/build-harness.ts` — so the root opens the database, registers it and the config as
`useValue` tokens, and resolves the rest in one synchronous call.

## Deferred, deliberately

Phases and phase briefs, thread delegation, session rotation across accounts, MCP server lifecycle,
skills precedence against `CLAUDE.md`, container/sandbox isolation, PR shipping. Each is an assembly
rule, a hook, or a port implementation — none requires reopening a decision above.

Known gaps in the contract, accepted: a hook cannot fail the turn or annul a tool result, and hooks
see one call at a time rather than a batch.
