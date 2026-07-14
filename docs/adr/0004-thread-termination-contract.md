# ADR 0004 — Thread termination contract (a typed terminal record replaces exception-shape inference)

- **Status:** Accepted — Phase 1 implemented (typed `complete_thread` + transient retry + `incomplete`); Phases 2 (live-verification judge) & 3 (`block_thread` + brain routing) pending.
- **Date:** 2026-07-03
- **Relates to:** ADR 0001 §18, §51–52 (the driver already self-marked builds `failed` on restart; fixed with a drain-aware catch — this ADR generalises that lesson: *the driver must never infer a thread's outcome from the shape of an exception*).
- **Updated by ADR 0008** (first-class stages): the `steps` table this ADR references throughout is retired.
  The terminal record now lives directly on the `threads` row (`threads.terminal_record`), and phase/anchor
  identity (`message.meta.phaseId`, `turn_stats.step_id`) repoints to `thread_id`. The contract described below
  (typed `complete_thread`/`block_thread`, transient-vs-real classification, the live-verification gate) is
  otherwise unchanged — only its storage anchor moved off `steps`.

## Context

The build driver (`backend/src/app/driver/thread-driver.service.ts`) decides whether a build thread is `done` or `failed` **purely from the control-flow shape of the engine turn** — it never inspects what the turn produced. From the code trace:

- **`drive()` termination** (`:242-277`): `try { runJob } catch`. `EngineAuthError` → `paused`; `election.isDraining()` → leave `running` (boot-resume); **every other exception → hard `failed`**. On the happy path, `runBatch` returning without throwing → steps marked `done` and the orchestrator's free-text `result.report` is captured (`:819-849`). **There is no inspection of the turn's output. "Didn't throw" *is* the definition of success.**
- **Completion notes are raw model prose** (`summarizeHandoff :1149-1161`): the "Thread complete / what changed / verifications / deviations" text the operator reads is the orchestrator's own closing message, joined and sliced to 4000 chars. Nothing verifies it.
- **Verification is build/test-only** (`prompt-kit/groups/worker.group.ts:57-59`): the mandate is "discover and run the repository's OWN typecheck/build/test tooling and FIX failures." There is **no live end-to-end mandate anywhere** — no server boot, no curl, no Playwright. The `test` subagent runs typecheck/build/lint/tests.
- **Handoff is thread→thread only** (`:374-390`, `:524`): `handoffOut` → next thread's `handoffIn`, durable but lossy prose. It **never reaches the job brain**. The `orientation` cheat-sheet hook (`:1366`) is wired but dead (nothing populates it since the plan turn was removed).

### Observed failures this explains

1. **False errors.** Only `EngineAuthError` and `EngineDetachedError` are special-cased. Any *other* transient (sandbox crash, network blip, engine hiccup) falls through to hard `failed`. The operator sees "error," clicks retry, and it runs clean — because the blip was transient and there was never a real failure. (Two occurrences reported.)
2. **Swallowed questions / premature done.** There is no terminal state for "the thread paused to ask." A thread that ends its turn with prose like *"no commit/push made, awaiting your go-ahead"* — without calling `request_operator_input` — returns without throwing and is marked **`done`**. The question is lost. (`awaiting_input` exists but requires an explicit tool call the model didn't make.)
3. **Unverifiable / fabricated verification.** "26 unit tests passed; runtime curl loop not exercised (no GCP/Firestore/Athena creds)" is a *sentence the model wrote*. The credential belief was likely **false** (creds are propagated via `CredentialResolver`), and the model used a hallucinated blocker as permission to skip the live check — then still marked the thread done.
4. **Orphaned handoff.** Useful end-of-thread notes ("things to know," "environmental gap," flagged items) propagate thread→thread as truncated prose but never reach the brain, which is the only actor with the context to decide what the operator should see or what should become a durable decision.

### The thesis at stake

Atlas's reason to exist is a **real end-to-end live check** — spin up the server, curl the endpoints, drive Playwright, observe real behaviour — not a typecheck plus unit tests. That is *exactly* what Claude Code does natively. Today the system never even *asks* for the live check, and even if it did, nothing would stop the model from claiming success without it.

## Decision

**A build thread's terminal state is determined by a required, typed terminal record emitted by the orchestrator — not by the shape of an exception, and not by prose.** The `drive()` try/catch is retained only as a *crash backstop*: an exception means the turn died, which is an **anomaly**, never a `done`.

Four riders, each anchored to a concrete call site:

### 1. Typed terminal record (`complete_thread` / `block_thread`)
The orchestrator turn ends by calling a host tool with a discriminated status:
- **`done`** — carrying structured fields: `summary`, `changes[]`, `verification[]` (see rider 3), `deviations[]`, `honestGaps[]`.
- **`blocked`** — carrying the actual `question` / `decision` / `needsEnv`, mapping to the existing `awaiting_input` thread status (generalised beyond `request_operator_input`).
- **`failed`** — carrying a structured failure record `{ kind: 'build'|'verification', failingStep, command, exitCode, stderrTail, reviewFindings? }`.

**Enforcement rule:** if the turn ends with **no terminal record and no exception**, that is `incomplete` (a new anomaly state, surfaced) — *never* silently `done`. This is the load-bearing inversion: completion becomes an explicit assertion, not the absence of a throw. Slots in at `runBatch`/`executeSteps` `:819-849`.

### 2. Transient-vs-real failure classification
Extend the `:257-272` error classification with a **transient tier** (sandbox/network/engine crash — join `EngineDetachedError`) → **bounded silent retry** (per-thread attempt budget), never surfaced to the operator as "error," never wakes anyone. Only a genuine `failed` terminal record (or an exhausted retry budget) becomes operator-visible `failed`. This directly removes the false-error class. (Echoes ADR-0001's drain-aware catch — same principle, wider net.)

### 3. Live verification as a gated evidence slot
Two coordinated changes — prompt *asks*, contract *enforces*:
- **Prompt** (`worker.group.ts`): add a real end-to-end mandate — boot the runtime, exercise the changed surface (curl endpoints / Playwright the UI), **capture evidence** (command + exit code + output tail).
- **Contract enforcement:** `verification[]` entries are structured `{ kind, command, exitCode, outputTail }`. A thread that touched a **runtime surface** (endpoint/UI) but has an **empty live-verification slot cannot be `done`** — it downgrades to `blocked (unverified)`. The prompt can request; only the contract can enforce.
- **Credential/env probe:** before any "no creds, skipping" is accepted, the agent must hit a real env/capability probe (what secrets are granted, what env is present). If creds exist, the excuse evaporates; if genuinely absent, it's a legitimate `blocked (needsEnv)` surfaced to the operator — not a `done`-with-a-caveat.

### 4. Terminal record routes to the brain
The typed terminal record (a) is rendered to `/context/generated/threads/<ordinal>-<slug>/completion.md` — a host-written projection like the other `/context/generated` renders (`decision-record.md`, `deviations.md`), read-only in-sandbox and surfaced in the operator UI, so it never appears in the git worktree — and (b) is delivered to the **job brain**, which triages each piece: next-thread handoff (finally populating the dead `orientation` hook), a durable memory entry, operator card, or a `blocked` question that *cannot be silently filed*. This replaces the lossy 4000-char prose handoff as the source of truth while keeping thread→thread carry for the happy path. The driver stays the deterministic loop; the brain gains decision authority **at the boundaries** (it does not own control flow — see Alternatives).

## Consequences

**Positive:** false errors disappear; paused-to-ask threads can no longer be marked done; "verified" becomes a checkable claim with evidence; the live end-to-end check becomes an *enforced gate* rather than a hope, which is the product's differentiator; the brain finally sees thread outcomes and can route them; the failure record becomes the shared input for the wake-on-failure design.

**Negative / costs:** a new tool contract + prompt rewrite + driver control-flow change all at once; a schema/enum change (new `incomplete` state, structured terminal payload persistence) requiring a migration; the orchestrator now *must* end with a tool call, so older resumable threads and the master-review path need a compatibility story; the live-verification gate will (correctly) surface more `blocked` threads that used to silently pass — a legibility win but an initial volume increase.

## Alternatives considered

- **Move the orchestration loop into the brain (LLM drives each next thread).** Rejected: the driver is deliberately a deterministic, resumable loop ("legible loop, NOT an implicit FSM"). LLM-driven control flow loses clean restart-replay (recovery becomes re-derivation) and costs an Opus turn per boundary. The terminal record gives the brain boundary-level authority *without* surrendering the loop.
- **Keep prose completion notes; parse them.** Rejected: unenforceable and non-durable — parsing free text can't gate on "did the live check actually run."
- **MD-file handoff only, no typed contract.** Rejected: the `.md` is the right *rendering* and durability layer, but a file can't be a machine-enforced gate. The typed record is primary; the `.md` is its projection.

## Open questions (for the implementation plan)

1. Persistence shape of the terminal record — new columns on `threads` / `steps`, or a dedicated table? (`incomplete` enum add + structured payload jsonb.)
2. How is `complete_thread`/`block_thread` registered on the **execute** turn's tool set, and how does the tool-bridge return control to `runBatch`? (Relationship to the existing `request_operator_input` tool.)
3. Backward-compat for in-flight / already-`done` resumed threads and the Codex **master-review** thread (does it emit a terminal record too?).
4. "Touched a runtime surface" detection — does the driver infer it (diff touched an HTTP/route/UI path) or does the orchestrator self-declare the surface it must live-verify?
5. Retry budget location + dedup for the transient tier (per-thread counter; interaction with boot-resume).
6. Brain delivery seam — reuse the event→brain harness-message path (as with reconciler events) vs a dedicated channel.
