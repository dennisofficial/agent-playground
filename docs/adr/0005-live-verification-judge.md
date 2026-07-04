# ADR 0005 — Live-verification judge (ADR 0004, Phase 2)

- **Status:** Proposed
- **Date:** 2026-07-03
- **Relates to:** ADR 0004 (thread termination contract), rider 3 — "Live verification as a gated evidence slot." That rider was committed to but not built; this ADR is its detailed design, informed by a live production run (job `26d74849`, Cubix Infra `/health/ping`) that exercised Phase 1 end-to-end today.

## Context

ADR 0004 shipped Phase 1 today: a typed `complete_thread`/`block_thread` terminal record, an `incomplete` anomaly state, and transient-vs-real failure classification. It was live-verified on a real job in this session (build thread completed with real curl evidence + a passing 200-test suite; two real infra bugs were found and fixed along the way — an idle-timeout false-death and a truncated failure-message bug).

That same live run is direct evidence for what Phase 2 still needs to close:

- **`complete_thread` has no enforcement today.** Its handler (`thread-driver.service.ts:766-798`) accepts `verification` as a fully optional array — a thread can call `complete_thread({ summary: "done" })` with zero evidence and it is unconditionally accepted as `status: 'done'`. `ThreadTerminalRecord.verification[]` (`thread.entity.ts:121-141`) is the right *shape* but nothing reads or gates on its contents.
- **Live verification happened today by accident, not by mandate.** The worker prompt (`worker.group.ts:57-59`) still only says "discover and run the repo's own typecheck/build/test." The build thread we watched DID boot Postgres+Redis+the app and curl a real endpoint — but only because Codex's plan-review loop happened to catch "the plan's validation section only calls for build+curl, but repo convention (`AGENTS.md`) also requires the full test suite" and forced a manual-curl step into *that specific plan's* validation section. A differently-shaped feature whose plan-authoring doesn't happen to trip that particular Codex finding sails through on typecheck+test alone — exactly the base case ADR-0004 described.
- **The orchestrator is trustworthy at the diagnostic work, once told to do it.** When it hit real environment gaps (Postgres down, then Redis down, then a process-supervisor cwd bug), it self-diagnosed and fixed every one rather than declaring a false blocker. This derisks the prompt half of rider 3 — a live-verification mandate is likely to be followed honestly, not theater'd around. (It is NOT evidence that the model can be trusted to self-*report* whether it did so — see the credential-probe finding below, which is exactly the opposite case: a model asserting an unverified negative.)
- **The credential probe still doesn't exist as something the orchestrator can act on.** `WorktreeSecretStore.listGrants()` / `.read()` exist at the store layer (confirmed via direct trace this session) and hydrate real files into the sandbox at turn start (`worktree-hydrator.service.ts`), but there is no rendered manifest and no host tool exposing "what's granted" to the orchestrator mid-turn. A model that assumes "no creds" today has no cheap way to check other than guessing paths — which is exactly the failure ADR-0004 cites (job `21a967e9`'s false "no GCP/Firestore/Athena creds" claim).
- **Master Review doesn't see per-thread verification evidence.** `renderMasterReviewTask` (`thread-driver.service.ts:1577-1596`) receives the decision record + repo, not each feature thread's `terminal_record`. Its own verify mandate (step 3) has the identical typecheck/build/test-only gap as the per-thread prompt. It IS a real, working, whole-diff Codex pass we watched execute live today (3 plan-review rounds, correct adjudication of a stale-snapshot false finding) — a strong existing seam, worth weighing as a home for the judge rather than building a parallel mechanism.
- **The house pattern for a cheap structured-output judge already exists**: `decision-gate/classifier-llm.ts` — a DI-bound interface, LangChain `ChatAnthropic.withStructuredOutput(zodSchema)`, a cheap model (Haiku), conservative fallback (defaults to the stricter verdict when the LLM is unavailable/ambiguous). Phase 2's judge should follow this shape, not a bespoke one.

### Why "did this touch a runtime surface" can't be either pure self-declaration or pure path-matching

Self-declaration alone is untrustworthy by the exact same evidence ADR-0004 cites (the false "no creds" claim was also a self-declaration). Pure path-pattern matching (route/controller/page file globs) is brittle: a shared validation function or a config default can change runtime behavior without touching an obviously-named file, and conversely a docs-only PR can touch a file matching `**/api/**` without needing a live check. This is a genuine judgment call — which is why ADR-0004 named this Phase "the live-verification **judge**," not "the live-verification linter."

## Decision

**A new judge gate sits between `complete_thread`'s `status: 'done'` claim and the driver actually persisting `done`.** It does not replace the prompt (which still asks for the live check) or the credential probe (which removes the false-blocker excuse) — it is the enforcement backstop for both, mirroring how Phase 1's `incomplete` state was the enforcement backstop for "the turn just stopped talking."

### 1. Extend the verify mandate (prompt half — `worker.group.ts` + `renderMasterReviewTask`)

Add an explicit live-verification instruction: for any change that touches a runtime-observable surface (an HTTP endpoint, a UI route/component, a CLI entry point, a background job/consumer), boot the affected process and exercise it for real (curl / Playwright / a direct invocation) — capture the **evidence**, not a claim: command, exit code, output tail. Feed this directly into `complete_thread`'s `verification[]` entries (already-shaped: `{ kind, command, exitCode, outputTail }` — add a `kind: 'live'` convention alongside today's implicit `'build'`/`'test'`). This is a prompt change only; it asks, it does not enforce.

### 2. The credential/env probe (removes the false-blocker excuse)

Render a durable, discoverable listing at turn start — `/context/generated/available-secrets.md` (files-as-store, matching the decision-ledger convention already used elsewhere), populated by `WorktreeHydratorService.hydrateFiles` alongside the values it already writes: granted secret **names and paths only**, never values (values are already on disk where hydration put them; the manifest solves *discoverability*, not access). The prompt instructs: before writing `needsEnv` into a `block_thread` call, read this file — an env gap is only real if the manifest confirms it's actually ungranted. No new host tool needed; this is strictly cheaper than a `check_credentials` tool round-trip and matches the existing pattern (decision ledger, specs) of durable files over bespoke tools.

### 3. The judge (enforcement — the actual Phase 2 gate)

A **cheap, structured, conservative-by-default LLM call**, modeled directly on `classifier-llm.ts`:

- **Input:** the thread's `terminal_record` (summary, changes, verification[], deviations, gaps) + a compact diff-shape signal (changed file paths, from `LocalGitService`/`AutoFixStage`'s existing `gitNameOnly` helper — reused, not reinvented) + the locked decisions.
- **Output (structured):** `{ runtimeSurfaceTouched: bool, liveVerificationAdequate: bool, reason: string, missingChecks?: string[] }`.
- **Conservative default:** on any judge failure/unavailability/ambiguity, `runtimeSurfaceTouched: true` + `liveVerificationAdequate: false` — i.e., fail toward `blocked (unverified)`, never toward a silent `done`. (Mirrors `classifier-llm.ts`'s "defaults to conservative `ask`" pattern exactly.)
- **Enforcement point:** `complete_thread`'s handler (`:766-798`) calls the judge before persisting `status: 'done'`. If `runtimeSurfaceTouched && !liveVerificationAdequate`, the record is persisted with `status: 'blocked'`, `blocked: { reason: 'unverified', detail: judge.reason }` instead of `'done'` — the orchestrator's own claim is downgraded, not trusted. This is the direct enforcement of ADR-0004 rider 3's promise: *"the prompt can request; only the contract can enforce."*
- **Placement — new gate vs. folding into Master Review:** two live options, not yet decided (see Open Questions #1). A standalone gate runs per-thread, catching gaps immediately (tighter feedback loop, cheaper Haiku-class call per thread). Folding into Master Review reuses an already-adopted, already-working whole-diff Codex pass (no new mechanism) but only catches gaps once at the very end (after every feature thread already believes it's done) and mixes "is this correct" review concerns with "was this verified" contract concerns in one pass.

### 4. Terminal record still routes to the brain (unchanged from ADR-0004 rider 4)

No change to this rider — the judge's verdict becomes one more field on the terminal record the brain triages, same seam (`deliverEvent`, durable, idempotent on `delivered_at`).

## Consequences

**Positive:** "verified" becomes a claim the *system* checks, not just one the prompt asks for — this is the direct fix for the ADR-0004 §3 failure mode (fabricated/unverifiable verification) and the actual product differentiator ADR-0004 names. The credential-probe manifest is cheap (a file, not a tool) and directly kills the exact false-blocker class observed in job `21a967e9`. Reusing `classifier-llm.ts`'s shape means the judge is unit-testable without a real LLM call, consistent with house style.

**Negative / costs:** a new LLM call per thread-completion (cost + latency, though Haiku-class and cheap per `classifier-llm.ts` precedent) or, if folded into Master Review instead, a meaningfully heavier Master Review prompt with two different reviewing concerns entangled. The judge is a genuine new failure surface (a bad judge call can itself wrongly downgrade a legitimately-done thread — the conservative default makes this fail toward "annoying extra `blocked`," never toward "silently wrong `done`," but it's still new operator-facing volume). "Runtime surface" detection is inherently fuzzy; expect the judge's early verdicts to need tuning against real jobs the way Codex's plan-review findings did today (round 1 → round 2 → round 3 before it converged).

## Alternatives considered

- **Pure driver-side path-pattern gate (no LLM judge at all).** Rejected as the *sole* mechanism: too brittle both ways (misses semantic runtime impact from non-obviously-named files; false-positives on docs-only changes matching a route glob). Can still serve as a *cheap pre-filter* feeding the judge's diff-shape signal (see Decision §3) — not a replacement for it.
- **Trust the orchestrator's own verification[] entries with no judge.** Rejected: this is exactly the trust ADR-0004 already showed is misplaced (the "no creds" self-declaration). An unenforced `verification[]` is just structured prose — a nicer-looking version of the same problem.
- **A new `check_credentials` host tool instead of a rendered manifest file.** Considered viable but heavier: needs tool-bridge wiring (`operatorInputBridge` pattern) for a need that's satisfiable by a file the hydrator already has the data to write. Kept as a fallback if the manifest proves insufficient in practice (e.g., secrets rotate mid-turn and the static manifest goes stale — the file is written once at turn start, same staleness window as the rest of the hydrated worktree).

## Open questions (for the implementation plan)

1. **New per-thread gate vs. folding into Master Review** — the single biggest open design choice (Decision §3). Needs a plan-mode ceremony decision, likely Codex-challenged given the tradeoff is real and not obviously one-sided.
2. **Judge model/cost** — Haiku (matching `classifier-llm.ts`) vs. a stronger model given "was this diff's runtime impact fully covered" is arguably a harder judgment than the decision-classifier's binary ask/proceed call.
3. **Manifest staleness** — is turn-start-only sufficient, or does a long-running thread (we saw one run 12+ minutes across environment fixes) need the manifest refreshed mid-turn if secrets change?
4. **Retry interaction** — if a thread gets downgraded to `blocked (unverified)` and the operator/brain nudges it to retry, does it re-run the FULL thread or resume just the verification step? (Echoes Phase 1's resumability model — should reuse it, not reinvent.)
5. **Master Review's own live-verification mandate** — independent of #1, should Master Review's step 3 (`renderMasterReviewTask`) get the same live-check mandate as the per-thread worker prompt, so a master-review-authored fix is itself live-verified? Today it inherits the same typecheck/build/test-only gap.
