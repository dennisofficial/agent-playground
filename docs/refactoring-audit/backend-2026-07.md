# Backend refactoring audit — daisy-chain handoff (2026-07)

This is the durable, in-repo handoff for an **autonomous, one-at-a-time remediation chain**. It is both the
**ordered slice queue** the chain works through and the **protocol** every link in the chain executes. Each
link (a single Atlas job) picks the first pending slice, re-verifies the finding still applies against the
current codebase, fixes exactly that one slice, proves it end-to-end, updates this doc, and spawns the next
link. There is no human diff gate — the safety net is mandatory live verification per link plus CI-gated
auto-merge (a red link stalls the chain for a human, it never bypasses).

Source material: this bootstrap job's backend audit (findings `C1`, `H1`–`H10`, `M1`–`M10`, `L1`–`L7`), scoped
to `backend/src/app/`. That audit report is job-local context and is **not** committed in-repo — the queue
below inlines every `path:line` anchor a link needs to act without it.

## The daisy-chain protocol

Every link (including the seed job that starts the chain) follows this contract exactly:

1. **Pick** the first slice in the queue below with Status `▢ pending` (top-down order is the plan).
2. **Re-verify** the finding still applies against the CURRENT base (the audit drifts as prior links land).
   If it's already fixed or moot, mark it `✓ moot` with a one-line note in its Evidence cell and pick the
   next pending slice instead.
3. **Fix** exactly that ONE slice, following its audit recommendation. Do not expand scope to neighbouring
   slices, even if the temptation is right there in the same file.
4. **Verify**: typecheck + unit/int floor, AND a **mandatory end-to-end run** — boot the affected surface and
   exercise it as a real caller would (curl the endpoint / drive the flow / run the tool), and confirm the
   observed behavior matches intent. Capture the evidence (logs, a screenshot, a command transcript).
5. **Update this doc**: set the slice's Status to `✓ done`, and add the PR/commit ref plus a one-line
   evidence pointer in its Evidence cell.
6. **Spawn the next link**: call `create_job` with `dependsOn: [<this job id>]` and
   `autoMode: { approveMode: 'ship', merge: true }`, `firstMessage` = this same protocol brief
   (self-replicating — the next link re-reads this very file). If NO pending slices remain, do NOT spawn a
   successor — instead add a "chain complete" line under the queue.
7. **Ship** — auto-approve + auto-merge carry the job through from here. If CI is red, the PR won't merge
   and the blocked successor never starts: the chain halts here for a human. Do not attempt to bypass a red
   CI gate — that gate is the entire safety mechanism replacing a human diff review.

## The slice queue

Ordered per the audit's remediation roadmap (enablers first, the keystone god-service split in the middle,
hardening/DRY/perf last). The C1 `AgentSessionManager` split is decomposed into five per-extraction
sub-slices (5a–5e) — one extracted service per link — because the whole split is too large for a single
link to fix and verify safely.

| # | Slice | Findings | Risk | Status | Evidence |
|---|---|---|---|---|---|
| 1 | Replace the `ModuleRef.get(JobLifecycleService,{strict:false})` service-locator call at `onboarding/onboarding.service.ts:519` with `@Inject(JOB_TEARDOWN) jobTeardown: JobTeardownPort` (`driver/job-teardown.port.ts`) — the port is already `@Global` and already injected cleanly elsewhere (`org/organization.service.ts:101`) | H4 | low | ✓ done | Link 1 (job `6379635c`). Injected `@Inject(JOB_TEARDOWN) jobTeardown` in `onboarding.service.ts`; dropped the lazy `import()`+`moduleRef.get` (moduleRef kept for slice #11 brain lookups). Verified: backend typecheck clean, `onboarding.service.spec.ts` 31/31, `boot.int.test.ts` 3/3 (no DI cycle), and **live** `DELETE /web/orgs/:orgId/repos/:repoId` → `200 {"ok":true,"threadsDeleted":1}` with runtime log proving `deleteJobDeep` fired through the injected port. |
| 2 | Add a `DriverApprovalGateway` neutral leaf module (mirroring the existing `BrainGateway` cycle-breaker pattern) exposing `resolveShip`/`retractShip`/`resolveMerge`/`neutralizeAmendProposal`; replace the 6 `ModuleRef`+lazy-`import()` lookups at `surface/web-surface.module.ts:212,226,245,246,263` and `surface/resolve-merge-approval.ts:18` | H5, L1 | low | ✓ done | Link 3 (job `08347afa`). New `@Global` `driver-approval-gateway/` leaf module (mirrors `brain-gateway/`); `DriverModule.onApplicationBootstrap` binds a driver-backed adapter; the surface injects the gateway as a typed collaborator. Deleted `resolve-merge-approval.ts`; controller `moduleRef` slot → `driverApproval`. The 7th lookup (`ProdDiagnosticsService` at `:296`) is NOT part of H5/L1 — left in place. Verified: backend `tsc --noEmit` clean, full unit suite 2654/2654; real-HTTP int `web-surface.auto-approve` (14, ship bridge→gateway→driver) + `web-surface.auto-merge` (8, `POST /approve` MERGE→`resolveMerge`→`mergeNow`) + `driver-store`/`shipping`/`host-retry-backstop` (36); and a **live** standalone boot (`:4002`, clean, no DI cycle) with a real curl `POST /approve` `atlas_approval:ship` → job flipped `awaiting_ship_review → running`, `ship_review_approved_at` stamped, `[ThreadDriver] ship approval … — re-driving to ship` logged (proving the driver handler fired through the bound gateway). |
| 3 | Register a global `APP_PIPE` `ValidationPipe({ whitelist:true, forbidNonWhitelisted:true, transform:true })` in `AppModule`; convert the un-validated interface DTOs in `surface/web-surface.controller.ts:355-468` (`CreateThreadDto`, `MessageBatchDto`, `ApproveDto`, `ProvideSecretDto`, etc.) to `class-validator`-decorated classes; drop the repeated per-controller local `ValidationPipe` instances | H6 | med | ▢ pending | |
| 4 | Guard the 4 hand-managed indexes (`idx_memory_embedding_hnsw`, `idx_tickets_embedding_hnsw`, `uq_threads_job_parent_ordinal`, `uq_threads_ticket_id`) against `migration:generate` drift — either `@Index(name,{synchronize:false})` or a post-generate prune lint — per the regression already caught+reversed in `backend/migrations/1783597139527-HaltOutcome.ts` / `1783601000000-RestoreDroppedIndexes.ts` | H7 | low | ▢ pending | |
| 5a | Extract `BrainToolRegistry` from `brain/agent-session-manager.service.ts` — the entire host-tool registry: `buildTools:3541` + ~25 `buildXxxTool` factories (`:5058-6352`) | C1 | high | ▢ pending | |
| 5b | Extract `CompactionService` from `agent-session-manager.service.ts` — `runCompaction:6834`, `reconcileStrandedCompactions:7077` | C1 | high | ▢ pending | |
| 5c | Extract `SeedCardDeliveryService` from `agent-session-manager.service.ts` — `stampLegacySeedCard:1335`, `backfillSeedDelivery:1498` | C1 | high | ▢ pending | |
| 5d | Extract `TurnReattachService` from `agent-session-manager.service.ts` — `reattachOwnedTurns:1984`, `drainInFlight:1936`, `runLeaderBootSweeps:660` | C1 | high | ▢ pending | |
| 5e | Extract `BrainPromptPrefixAssembler` from `agent-session-manager.service.ts` — `buildAwarenessPrefix:7452`, `buildMemoryRecallPrefix:7570` — then migrate `agent-session-manager.spec.ts` (brittle 30+-arg positional `new` at `:634,3643,5232`) to `Test.createTestingModule` + `.overrideProvider()` now that the constructor is decomposed | C1, H8 | high | ▢ pending | |
| 6 | Split `surface/web-surface.controller.ts` (3682 LOC, ~40 handlers, ~30 deps) into feature controllers (`JobsController`, `JobMessagesController`, `JobFilesController`, `JobPipelineController`, `PreviewController`, `ProposalsApprovalController`); move the 4 raw `@InjectRepository` uses (`:741-751`, jobs/messages/repos/subagents) behind a store service | H1 | med | ▢ pending | |
| 7 | Extract `HaltRelayService` from `driver/thread-driver.service.ts` (`classifyAndSurfaceAuthHalt:1047`, `relayRetrying:1243`, `relayPaused:1268`, `relaySessionLimitPaused:1311`, `relayFailure:1441`); fold the ship-gate methods (`parkForShipReview:1860`, `resolveShipApprovalDurably:1945`, `retractShipDurably:2035`) into the existing `BuildShipService` | H3 | med | ▢ pending | |
| 8 | Demote over-broad `@Global()` modules (27 of ~42 — brain, driver, surface, sandbox, onboarding, org, mcp, exposure, realtime, prompt-kit, …) to explicit `imports:` arrays, keeping only genuine cross-cutting singletons (`persistence`, `cluster`, `env/logger`, arguably `CHAT_SURFACE`) global | H2, L1 | med | ▢ pending | |
| 9 | DRY sweep: single-source `ATLAS_AUTHOR` const + `atlasCardRow(...)` builder (kills ~18 duplicated author-literal sites across `brain-store.service.ts`, `driver-store.service.ts`, `auto-merge.service.ts`, `turn-backfill.ts`, `agent-session-manager.service.ts`, `turn-harness.service.ts`, `prod-diagnostics.service.ts`); one `toJobRow(entity, {...})` mapper replacing the duplicated REST+realtime projection (`web-surface.controller.ts:852-905,951-969,3612,3646` + `realtime/job-realtime.model.ts:117`); generic `openProposalCard`/`getCardByType<T>` replacing the copy-pasted proposal-card trios (`brain-store.service.ts:1271-1414`); a shared `JobRowWriter` for the duplicated `setActivity`/halt writers (`brain-store:1598`, `driver-store:276`) + `requireJob(jobId)` replacing ~10 ad-hoc existence-guard re-queries + a stimulus query-builder base for `stimulus-store.service.ts:623,630,644,661,676`; promote `registerAndLogin`/`seedOrgRepo` into the shared `e2e/e2e-harness.service.ts` for the ~11 int tests that redefine them | H9, H10, M1, M6, M10 | low | ▢ pending | |
| 10 | Perf: fix the `recomputeBuildStageProgress` N+1 (`driver-store.service.ts:302-309`, per-thread-group query in a loop → single `WHERE thread_group_id IN (:...ids)`); paginate the unbounded transcript load (`web-surface.controller.ts:1159`); push the open-card lookup predicate into SQL with `LIMIT 1` (`driver-store.service.ts:143`) | M3, M4 | low | ▢ pending | |
| 11 | Remaining service-locator ports — `JOB_SPAWNER`/`ONBOARDING_BRAIN` (`onboarding.service.ts:276,277,346,347`), `REPO_ACCESS_REVALIDATOR` (`job-lifecycle.service.ts:352`), `PROD_WRITE_RESOLVER` (`web-surface.module.ts:296`); add `AllExceptionsFilter` (`APP_FILTER`) with request-context logging; add `@nestjs/throttler` + global `ThrottlerGuard` with tight `@Throttle` on `/auth/login` + `/auth/register`; add `@Exclude()` on `UserEntity.password_hash` + global `ClassSerializerInterceptor` | M2, M7, M8 | low-med | ▢ pending | |

## Arming note

This bootstrap job and fix job #1 (`6379635c`) were both **created before the `autoMode` create_job tool
shipped** — the operator must arm both of them full-auto (`approveMode: 'ship'`, `merge: true`) by hand after
this bootstrap PR merges. From link #2 onward, every job in the chain self-arms via the `autoMode` override
on `create_job` (step 6 of the protocol above) — no further manual arming is needed unless the chain halts on
a red CI gate.
