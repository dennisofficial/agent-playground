# Atlas web console — backend gaps

This frontend was built **frontend-only**: it targets the ideal `/web/*` contract and works around the
gaps client-side. Each item below is something the Atlas web surface (`backend/src/atlas/surface/`) needs
before the corresponding UI is fully real instead of derived/placeholder. Ordered roughly by impact.

The web client talks to `/web/*` **same-origin** (proxied by `web/next.config.ts` + `web/src/app/web/events/route.ts`),
so enabling CORS on the Atlas HTTP app is optional unless the team wants a direct browser→:4002 connection.

---

### 1. `GET /web/threads` (+ `GET /web/threads/:id`) — structured, persisted thread read model · **biggest gap**
Today `GET /web/thread` and `GET /web/channels` read only the **in-memory, outbound-only** `AtlasWebSurface.outbox`
(`atlas-web-surface.ts:83-84, 206-211`). That means: no persisted `atlas_threads`, no threads without a current-process
outbox, and **no human inbound messages**. The sidebar + Coordinator are therefore **demo / live-outbox only**.
*Wanted:* a read model over `atlas_threads`/`atlas_jobs` returning `{ id, title, kind, status, branch, tracker, meta, channel, threadTs }`.
*Client workaround:* `web/src/lib/api/messages.ts` derives a thread list from the outbox; flip `useThreadList` to the real endpoint when it exists.

### 2. History omits the operator's own messages **and** drops the thread root
`POST /web/say` pushes inbound to `inboundSubject` and never stores it, so the user's own messages never come back
via history or SSE. Separately, `GET /web/thread?threadTs=` filters `m.threadTs === threadTs`
(`atlas-web-surface.ts:207`), which **excludes the root post** (its own `ts` *is* the threadTs).
*Wanted:* persist inbound into the channel history, and include the root in the `threadTs` filter (`m.ts === threadTs || m.threadTs === threadTs`).
*Client workaround:* optimistic-append for sent messages; fetch the whole channel and coalesce the root client-side.

### 3. No `threadId` is exposed, so `GET /web/pipeline` is unreachable from the web
`GET /web/pipeline` needs `threadId` (`atlas_threads.id`) + `teamId`, but `/web/say` returns only `{ ts }`
(`web-surface.controller.ts`), `ChatStimulusBridge` keeps `atlas_threads.id` internal, and outbound message `meta`
carries only `{ kind:'build_event', phaseId, sectionOrdinal, phaseOrdinal, eventKind }` (`section-driver.service.ts`) —
no `threadId`.
*Wanted:* return `threadId` from `/web/say` and/or include it in message `meta` (or ship `/web/threads`).
*Client workaround:* the navigator pipeline tree is **derived** from `build_event` meta + approval/verdict cards
(`usePipelineOutline`). Flip to a real `usePipeline(threadId, teamId)` once `threadId` is available.

### 4. `getPipelineState` returns no `pr_url` / branch / diff
`DriverStoreService.getPipelineState` returns `{ jobId, title, kind, status, decisionRecordId, sections:[{id,ordinal,brief,status}] }`
only (`driver-store.service.ts:191`) — the controller comment claiming `pr_url` is inaccurate. Done-state **artifacts**
(the PR card, branch link, file diff) have no read model.
*Wanted:* add `pr_url` + branch to the pipeline payload (and a diff/artifacts endpoint for the done state).

### 5. `POST /web/approve` silently drops `note`
The controller accepts `note` then discards it before `approval$`; `WebSurfaceModule` resolves only
`{ actionId, value, ruledBy }`, while the brain reads a `resolution.note` it never receives
(`web-surface.controller.ts`, `web-surface.module.ts`, `agent-session-manager.service.ts`).
*Wanted:* plumb `note` through `approval$` → `DecisionApprovalService.resolve` so Request-changes/Deny can carry a reason.
*Client workaround:* the verdict buttons carry no note field; operator reasoning goes through the composer.

### 6. Per-phase read endpoints (transcript / diff / logs / auto-fix)
The Build-phase view (Transcript/Diff/Logs tabs) and the 3-lens Auto-fix cards have no backing API. Even job+section
state is unreachable today (see #3).
*Wanted:* phase-scoped transcript, diff, and logs endpoints.
*Client workaround:* the transcript shows the thread's `build_event` relays; diff/logs are placeholders.

### 7. Authentication (`/auth/*`)
There is no auth/session backend yet. The console ships all six design auth screens behind a **flip-ready stub**
(`web/src/lib/auth.ts`, `NEXT_PUBLIC_AUTH_MODE=stub|real`) that mirrors the real `@workspace/auth` surface
(`signIn` / `register` / `signOut` / `initialize` / `onAuthStateChanged`).
*Wanted:* `/auth/*` (session / login / register / signout / Google OAuth) **and a forgot/reset route** — the latter has
no method in `@workspace/auth` today. Then set `NEXT_PUBLIC_AUTH_MODE=real`.

### 8. Repo + branch listing, and onboarding (engine-cred / repo-connection) status
Create-Thread needs a repo list (we use `/web/channels`), a branch list (none today — free-text field), and a
provisioning/credentials status for the onboarding empty states.

### 9. Production resume route
Paused-on-credentials jobs resume only via the ops-only `POST /test/resume { jobId }`.
*Wanted:* a production `POST /web/resume { jobId }`.

### 10. Structured message typing
Decision / system-event / park-and-ask / PR bubbles are inferred from message `text` (`web/src/lib/api/classify.ts`).
*Wanted:* a structured `meta.kind` (or card type) on every special message so the client doesn't string-sniff.

### 11. CORS (optional)
Only needed if the team prefers a direct browser→`ATLAS_HTTP_URL` connection instead of the same-origin proxy:
`app.enableCors({ origin, credentials })` in `backend/src/atlas-main.ts`.
