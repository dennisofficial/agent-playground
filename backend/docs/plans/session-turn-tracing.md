# Plan: Trace session/engine turns in Langfuse (nested under the spawning tool call)

## Goal

Make the work that runs **inside** a session turn visible in Langfuse as **exactly one observation per turn** — carrying the engine `systemPrompt`, the real first/next message (`openingTask`/reply), the engine `result`, and `model`/`mode`/`engine` metadata — nested under the chat-turn span that spawned it, and grouped into a per-session timeline.

Today this work is invisible: the Claude/Codex engines are subprocess SDKs that emit no spans, and `runSessionTurn` is fired fire-and-forget inside `AsyncLocalStorageProviderSingleton.run(undefined, …)`, which severs the LangChain callback context. The `create_session` span the user sees only shows the tool args, not the engine work it kicks off.

## Cost constraint (explicit from user)

- **One span per tool call / per session turn is fine.** Tracing "every tool" is acceptable.
- **Do NOT fan out many child observations inside a tool call.** So the session turn gets a *single* observation — we do NOT trace per-engine-event, per-LLM-call, or the lifecycle/self-review sub-runs as separate spans in v1.

## Key technique (borrowed from ortho-backend-v3)

A Langfuse parent is reducible to a plain `SpanContext` = `{ traceId, spanId, traceFlags }` (`packages/langfuse/src/langfuse.utils.ts:parseParentContext`, fed to `startObservation(name, attrs, { parentSpanContext })`). Because it's a **serializable value threaded by reference**, it survives the ALS detach and fire-and-forget boundary — we do **not** rely on OTel active-context propagation. This is exactly how ortho nests detached work.

## Changes

### 1. Port a slim tracer helper into `@workspace/langfuse` (`packages/nestjs-ai-essentials/langfuse`)

`@langfuse/tracing` (5.4.1) is already a dependency. Add `src/langfuse.tracer.ts` exporting:

- `parseParentContext(parent?: SpanContext): SpanContext` — return the given context, or generate a fresh `{ traceId, spanId, traceFlags: 1 }` (crypto random hex, same as ortho `langfuse.utils.ts`).
- `traceChild<T>(fn: () => Promise<T>, opts): Promise<T>` — a **single-observation** wrapper around `startObservation(name, { input, metadata }, { asType: 'span', parentSpanContext })`. It runs `fn`, captures `output` (when `captureOutput`), records ERROR level + status message on throw, and `.end()`s in `finally`. Opts: `{ name, parentSpanContext?, sessionId?, input?, metadata?, captureOutput? }`. `sessionId` is set via `propagateAttributes`/the observation's session field so each background session forms a Langfuse session timeline.
- When `tracingEnabled` is false (no Langfuse keys), `traceChild` just calls `fn()` directly — no observation. (Mirror the `message_dropped` no-op gate in `conductor.service.ts:522`.)

Export from `index.ts`. Trim ortho's version: **no** media handling, **no** input/output media transforms, **no** nested `RunTracer.from` callback-bridge (we are deliberately NOT nesting engine internals).

### 2. Surface the parent `SpanContext` on `HarnessToolContext`

- `tool.types.ts`: add `parentSpan?: SpanContext` to `HarnessToolContext`.
- `tool.registry.ts` `toStructuredTools` (the single adapter seam, line 61): capture `trace.getActiveSpan()?.spanContext()` (`@opentelemetry/api`, already imported in `conductor.service.ts:3`) at call time and pass `{ identity, parentSpan }` into `impl.execute`. Cheap — captures the existing tool-call span, creates nothing.
- **Fallback by design:** if no active span is present at the seam (uncertain whether the `LangfuseCallbackHandler` activates OTel context there), `parentSpan` is `undefined`; the session turn then starts a fresh root trace but is still grouped by `sessionId`. Correctness does not depend on the active span existing.

### 3. Thread `parentSpan` to `runSessionTurn` (per turn, not stored)

The parent differs per turn (create vs each `reply_session` comes from a different chat turn), so capture it at each call, never persist it on the session.

- `runSessionTurn(sessionId, message, parentSpan?)` — new optional 3rd arg. Survives the ALS detach because it's an explicit value.
- `CreateSessionTool.openSession(opts)` — add `parentSpan?` to opts; pass into the `runSessionTurn` call (line 173). `execute` reads `ctx.parentSpan`.
- `ReplySessionTool.execute` → `runner.replySession(sessionId, message, mode, parentSpan?)` → its internal `runSessionTurn` call (line 333).
- Other `openSession` callers — `engine-tool.factory.ts:59` and `investigate.tool.ts:65` — pass their `ctx.parentSpan` too (covers capabilities + the global `investigate` tool).

### 4. Emit the single session-turn observation in `runSessionTurn`

Wrap **only** the `this.engines.get(session.engine).run({...})` call (`session-runner.service.ts:127-150`) in `traceChild`:

- `name`: `session.turn` (label includes engine/mode, e.g. `session.turn:claude:execute`).
- `parentSpanContext`: `parseParentContext(parentSpan)`.
- `sessionId`: the harness `sessionId` → per-session Langfuse timeline. With a `parentSpan`, the turn also nests inside that chat turn's trace (same `traceId`); the user's original ask — "create_session as the parent observation" — is satisfied. Late-arriving spans on an already-exported trace are fine (standard OTel).
- `input`: `message` (the real `openingTask`/reply — finally visible, incl. the Option-B plan handoff).
- `metadata`: `{ systemPrompt, model, effort, mode, engine, boardTaskId, agentId: bot.id, worktree: worktree.id, turn: session.turns + 1 }`.
- `output`: the engine `result` on success; ERROR level + message on throw.
- Keep it to **one** observation: the lifecycle/self-review runner (`session-runner.service.ts:197`) and its separate engine.run are **not** separately traced in v1 (respects the cost constraint). Note as a follow-up.

### 5. No changes to flush/bootstrap

`_core/tracing.ts` (OTel SDK + `LangfuseSpanProcessor`) and `LangfuseFlushService` already export spans created via `@langfuse/tracing`. No wiring change.

## Design decision to confirm

**Nesting + session grouping (recommended)** vs **standalone session trace + back-link only.** The plan does both naturally: nest under the chat turn when a `parentSpan` exists, AND set `sessionId` so a session's turns form one timeline. Alternative (if preferred): always start a fresh root trace per session turn and only carry the chat turn's id as a `traceparent` metadata link (no nesting). Recommendation: the combined approach — it directly answers the original "create_session as parent" ask while keeping the session timeline coherent.

## Verification

- `pnpm typecheck` (backend).
- Unit: extend `session.tools.spec.ts` / `session-runner.service.spec.ts` to assert `runSessionTurn` receives/threads `parentSpan` and that `traceChild` is invoked with the right `name`/`input`/`metadata` (mock the tracer; assert no-op when `tracingEnabled` is false).
- Manual (Dennis, billed): run a board-task plan→execute, confirm in Langfuse one `session.turn` observation per turn, nested under the spawning chat turn, grouped under the session, with `systemPrompt` + `openingTask` + `result` visible.

## Out of scope (v1)

- Per-engine-step / per-LLM-call observations inside a turn (cost).
- Tracing lifecycle/self-review secondary engine runs.
- Bridging the in-process LangGraph engine's internal runs via `RunTracer.from` (would multiply observations).
