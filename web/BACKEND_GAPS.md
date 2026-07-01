# Backend gaps — job workspace

What the **job workspace** (navigator + Conversation + build steps) still has to placeholder or derive
because the web API doesn't expose it yet. Everything else is wired to the real
`org → repo → job` API (`messages`, `say`, `approve`, `pipeline`, `events`, `context`, repo list,
create/retry/delete).

> Vocabulary: a **Job** is the container (branch + sandbox + PR + one message log); a **Job** has many
> **Threads** (build lanes) each with **Steps**. Routes live under `/web/orgs/:orgId/repos/:repoId/jobs…`;
> the cross-org inbox is `/web/jobs`. (This file predates that rename in its earlier form — the old
> "thread" = today's **job**, the old "track/phase" = today's **thread/step**.)

The conversation, the approval gate, the pipeline thread/step tree, create-job, retry, live status, the
`/context` doc tree, and open-from-anywhere are all real. The gaps below are isolated and labeled in the UI.

## Closed since the first writing

The org→repo→job rebuild, the realtime feed, the unified transcript spine, and the generated
decision-record all landed — these earlier gaps are **gone**:

- **Live status on the inbox** — `GET /web/jobs` now returns `status`, `turnActive`, and a server-derived
  `needsYou` (`deriveNeedsYou` in `backend/src/app/domain/job.ts`), and there's a cross-org realtime SSE
  at `GET /web/jobs/realtime` that the shell subscribes to once (`web/src/lib/api/all-jobs-realtime.ts`) to
  keep every sidebar dot / status pie live. The per-repo list `GET …/repos/:repoId/jobs` carries the same
  fields plus `baseBranch`.
- **Stream frames are job-keyed, not surface-`thread_ts`-keyed** — the repo SSE frames now carry an explicit
  `jobId` + a `lane` (`main` for the brain, `phase:<stepId>` for a build), fed per-job/per-lane into the
  live-turn store (`web/src/lib/api/job-stream.ts`). No more mapping a Slack-style `thread_ts` to a UUID.
- **Build transcript is real, unified into the conversation spine** — build steps ride a `phase:<anchorStepId>`
  lane and render as `BuildStepCard` / a step sub-page (via `meta.phaseId`), not the old non-durable
  `build_event` relay. Per-step metadata (`batchOrdinal`, `anchorStepId`, `batchStepIds`) comes down in
  `/pipeline`.
- **Decision record + plan content** — a generated `decision-record.md` is written into the read-only
  `/context/generated/` bucket (`backend/src/app/brain/decision-record-md.ts`), listed by
  `GET …/jobs/:jobId/context` and fetched by `…/context/file`. `/pipeline` also exposes `decisionRecordId`.
- **Git branch exposed** — `/pipeline` returns `featureBranch` + `baseBranch` (+ `prUrl`/`prNumber`); the
  navigator header renders the branch with a git icon.
- **Retry op route** — `POST …/jobs/:jobId/retry` re-drives a `failed`/`paused` build through the
  deterministic resumable driver (the halted-build Retry button).

## Remaining gaps

### 1. No diff endpoint (and review findings aren't browsable)
The navigator's **Changes** row and the `diff` detail node exist, but `DiffView` is a labeled placeholder —
the accumulated diff isn't exposed by the web surface; it lives on the feature branch and lands in the PR
(review it on GitHub via the PR link). The navigator can't show a real `+/−` line stat for the same reason
(it only knows "no changes yet" from the build status). Separately, review-lens findings run as parallel
self-review passes over the diff but are **relayed into the conversation, not persisted**, so the per-lens
review detail views are placeholders too. Needs a diff read endpoint (`…/jobs/:jobId/diff` or per-step) and,
optionally, persisted review findings.

### 2. No explicit steering op routes (pause / revert-step / mark-PR-ready)
Steering is done by **talking to the job** (`say`) — "pause", "revert that step", "the PR's ready" — which
the brain interprets, plus the dedicated `retry`, `approve`, and `answer-question` routes. There are **no**
dedicated routes for **Pause**, **Revert step**, or **Mark PR ready**; those buttons stay disabled. (`retry`
already covers the resume-a-`paused`/`failed`-build case.)

### 3. Inbox can't distinguish `fix` from `feat`
The inbox derives `kind` from `origin` only (`origin === 'event'` → event; everything else reads as `feat`
in `web/src/lib/api/inbox.ts`). A control-created bugfix job therefore shows as `feat` on the board. Needs a
real `kind`/`fix` signal on the job list payload.

### 4. Tracker link not populated
The navigator header renders a `tracker` ref (`JobMeta.tracker`) when present, but nothing on the wire
populates it — no inbox row or `/pipeline` field carries an external issue/ticket ref yet. Add a tracker ref
to the job read to light it up.

### 5. (By design, noted for completeness) SSE is repo-scoped
`GET …/repos/:repoId/events` emits frames for **every** job in the repo over one standing connection (kept
per `(orgId, repoId)`, not per job, so switching jobs within a repo doesn't churn the connection). Live
`stream` frames are routed by their `jobId`/`lane`; non-stream `message` frames are used as a debounced
change-signal that refetches the open job's `messages` + `pipeline` + `context`. Cost: a sibling job's
activity also triggers a refetch — acceptable for an operator console, and intentional rather than a gap.
