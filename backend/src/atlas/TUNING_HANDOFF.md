# Atlas v2 — Tuning Session Handoff

> **Your mission:** run an iterative **TUNE → TEST loop** on Atlas v2 — drive realistic scenarios through a live Atlas, observe what's weak, fix it in `backend/src/atlas/`, re-test, repeat. The architecture is sound and proven (it ships clean PRs); these are **brain / communication / gate tuning** fixes, **not** a re-architecture. The issues below were found in a live 6-scenario test pass — reproduce, fix, and re-verify each.

## 0. Orient first
- Read `backend/src/atlas/ATLAS_V2.md` (canonical: architecture, file/seam map, run+verify, env). Design history: `/Users/dennis/.claude/plans/this-ai-orchestrator-is-greedy-parnas.md`. Memory: `atlas-v2-clean-room-rebuild`.
- Branch `feat/atlas-v2`; built + committed (`0e4dbd2`); 190+ atlas tests green; v1 (`backend/src/harness/`) is **intact beside v2 — do NOT delete it** (that's "W8", held for Dennis).
- **Run in the MAIN repo checkout, NOT a fresh worktree** — the secrets (`ANTHROPIC_API_KEY`, `GITHUB_PAT`, decrypt keys) live in gitignored `backend/.env.personal` + `.env.keys`, which a worktree won't have.
- **HARD RULES:** zero imports from `harness/**` or v1 `slack-app/**` (grep to confirm). No `Co-Authored-By` in commits. Don't delete v1. Don't edit `.env.personal` beyond what's there. Conversational *wording/tone* is Dennis's to tune — you fix **structural behavior** (does it investigate? relay? does the gate fire?) and flag subjective-feel items for him.

## 1. The test loop (harness already exists)
1. Boot (from `backend/`, background it): `ATLAS_SURFACE=agent ATLAS_TEST_BRIDGE=on ATLAS_DISABLE_RESUME=1 pnpm atlas:dev` → HTTP on `:4002`.
2. Seed a channel → real repo: `curl -sS -X POST localhost:4002/test/seed -H 'content-type: application/json' -d '{"teamId":"T-TEST","projectId":"ai-crew","repoUrl":"https://github.com/dennisofficial/ai-crew","baseBranch":"main","channel":"C-TEST"}'`
3. Converse: `POST /test/say {channel,text,threadTs?}` → `{threadTs, replies:[{text}], approvalCard?:{jobId,title}}`. Approve: `POST /test/approve {jobId,verdict}`. Poll: `GET /test/job?jobId=`. Transcript: `GET /test/thread?threadTs=`.
4. For breadth, spawn subagents as "users" (one Atlas instance handles many threads concurrently). The target repo `dennisofficial/ai-crew` **is this monorepo itself**; test PRs are drafts (won't merge) — periodically `gh pr close` + delete `atlas/*` branches. Existing test artifacts to clean: PRs #44/#45/#46 + dead `atlas/*` branches.
5. Verify every change: `pnpm -C backend vitest run src/atlas` + `pnpm -C backend typecheck` (the ONLY pre-existing failure to ignore: `src/daemon/rpc/daemon-readiness.service.spec.ts`).

## 2. Issues to fix (ranked — fix top-down, re-test after each)

**1. Brain interrogates instead of investigating (TOP).** In the grill/triage it asks the user for things it could read from the repo (tech stack, whether a file exists, repo size, dead-code tooling) — even when told "go look." The execution engine reads code well; bring that into PLANNING: run a read-only investigation pass over the cloned repo before/while grilling, so questions + plans are grounded in real facts. Files: `brain/conversational-brain.service.ts`, `brain/triage.service.ts`, `brain/brain-llm.ts` (grill prompt). **Done when:** on vague/deletion/bugfix scenarios it grounds in repo facts and stops asking self-answerable questions.

**2. Silent on failure (and progress).** A failed job posts NOTHING — the approval card dead-ends; no chatter during builds. Wire a **failure-relay + progress-relay** from the driver to `CHAT_SURFACE`. Files: `driver/section-driver.service.ts` (the failRun/catch + per-phase progress), `surface/`. **Done when:** a failing/struggling job posts a clear "failed because X" and periodic progress in-thread.

**3. No circuit-breaker on hard builds.** One bugfix ran **~86 min** then failed. Add a wall-clock / turn budget per job (+ per phase) that aborts and relays. Files: `driver/`, new env (e.g. `ATLAS_JOB_TIMEOUT_MS`). **Done when:** no job runs absurdly long; it aborts + reports.

**4. Shallow verification ("guess, don't verify").** It labeled *live, tested* code "unused" (grep-for-imports, no tsc, missed intra-file callers); the bugfix never ran the test. Deletion/bugfix work must VERIFY (run tsc / the failing test; check intra-file + cross-file refs) before claiming done. Files: `driver/` (execute/verify step), `autofix/` lenses, planner/section prompts in `driver/planner-llm.ts`. **Done when:** the deletion scenario won't remove referenced code, and a bugfix proves the test passes.

**5. Always-ask gate has security blind spots.** On "add JWT auth" it asked about datastore/schema/guard but NOT password-hashing algo, JWT lib, or token strategy; the per-section mid-build park never fired. Broaden the classifier's coverage (esp. security/crypto/auth-mechanism + new deps) and make the per-section gate actually park on uncovered always-ask decisions surfaced during planning. Files: `decision-gate/decision-classifier.service.ts` (rules + prompt), `driver/section-driver.service.ts` (per-section gate call). **Done when:** auth/crypto/dep decisions get surfaced or parked.

**6. No "answer a question" lane.** "What does this repo do?" was silently ignored — triage is binary (build or silence). Add a triage path where a non-work question gets a conversational, repo-grounded answer. Files: `brain/triage.service.ts` (verbs), `brain/conversational-brain.service.ts`. **Done when:** questions get answered, praise still ignored, work still dispatched.

**7. Opaque approvals.** The approval card exposes only the plan TITLE, not the body; off-spec deviations are silent (it invented a README without saying so). Include the plan body (sections + key decisions) in the card and note material deviations in-thread. Files: `brain/decision-approval.service.ts`, `surface/approval-blocks.ts`, `brain/conversational-brain.service.ts`.

**Lower priority (ties to #1):** the brain over-decomposes vaguer tasks into a pointless "investigate the codebase" *section* (a full plan→execute→autofix cycle that commits nothing). A 0-changed-files auto-fix skip is already in; fold investigation into planning so it's never a build section.

## 3. Loop methodology & "done"
Pick the top unfixed issue → reproduce via the bridge → fix in `backend/src/atlas/` → add/adjust `*.spec.ts` + keep the boot int test green → re-run the scenario live to confirm → next. Re-run the full 6-scenario matrix periodically for regressions. **Overall done when** the matrix shows: brain grounds in the repo, failures+progress relay in-thread, no runaway builds, deletions/bugfixes verified before "done," the gate surfaces security/arch decisions, questions answered, approval card shows the real plan. Report before/after per issue.
