# Atlas Web Operator Console — Frontend Rebuild

## Context

Atlas (the clean-room coding-agent orchestrator in `backend/src/atlas/`) is driven today over Slack and an
in-process surface. There is **no real web UI**. A design handoff (`/tmp/atlas_handoff/design_handoff_atlas_frontend/`)
specifies the *first* web operator console: sign in → see all threads → open a thread → talk to its brain →
watch a phase build live → approve/deny plans → answer parked decisions. The backend already ships a
purpose-built web surface (`/web/*` HTTP + SSE, port 4002, `ATLAS_SURFACE=web`).

The current `web/` app is the *old harness admin* (board / memory / plan-viewer, pointed at the :4000 admin API).
Per Dennis: **scratch the existing frontend** and rebuild `web/` as the Atlas operator console. We keep the
proven house *infrastructure* (Next 16 + React 19, `@workspace/auth`, `@t3-oss/env-nextjs`, Tailwind v4, dotenvx
env injection, route-group + client-guard protected-route pattern from `rs-crm-app` / `cubix-infra`) and replace
all app pages/components with the console.

### Locked decisions (from clarifying Q&A)
1. **Backend scope = frontend-only.** No backend commits. Build against the *ideal* contract, work around gaps
   client-side (same-origin proxy for CORS/SSE, derived thread list), and **document every missing endpoint**
   in a `web/BACKEND_GAPS.md` for a follow-up backend pass.

### Hard backend realities verified against disk (drive the design — Codex review pass)
- **`AtlasWebSurface.outbox` is in-memory and OUTBOUND-only** (`atlas-web-surface.ts:83-84, 206-211`). `/web/thread`
  and `/web/channels` reflect only *this process's* Atlas posts — **not** persisted `atlas_threads`, not threads
  with no current outbox, and **not the human's own messages** (inbound goes to `inboundSubject`, never stored).
  ⇒ A derived thread list is **demo / live-outbox-only**, and the Conversation view must **optimistically append
  the user's own sent messages** (they never come back via history or SSE).
- **`/web/thread?threadTs=` drops the thread's root post** — `channelMessages` filters `m.threadTs === threadTs`
  (`atlas-web-surface.ts:207`), but a root post's own `ts` *is* the threadTs and it carries no `threadTs`. ⇒ fetch the
  whole channel and coalesce **`m.ts === threadTs || m.threadTs === threadTs`** client-side, or event-origin threads
  lose their headline.
- **`GET /web/pipeline` exists but is NOT reachable from the web client this pass.** It needs `threadId`
  (`atlas_threads.id`) + `teamId`, but the web contract never exposes `threadId`: `/web/say` returns only `{ts}`
  (`web-surface.controller.ts:116`), `ChatStimulusBridge` keeps `atlas_threads.id` internal (`chat-stimulus.bridge.ts:89`),
  and outbound message `meta` carries only `{kind:'build_event',phaseId,sectionOrdinal,phaseOrdinal,eventKind}` — **no
  threadId** (`section-driver.service.ts:891`). Also `getPipelineState` returns `{jobId,title,kind,status,
  decisionRecordId,sections:[{id,ordinal,brief,status}]}` — **no `pr_url`, no branch, no diff** (the controller comment
  is wrong; `driver-store.service.ts:191`). ⇒ The Navigator renders a **partial outline derived from `build_event`
  meta** in the live stream (section/phase ordinals) + job state inferred from approval/verdict cards; full pipeline
  state, decision record, and done-state artifacts (PR/branch/diff) are **flagged** as needing `/web/threads` (or a
  `threadId`-bearing `/web/say` response / message meta).
- **`POST /web/approve` silently DROPS `note`** (`web-surface.controller.ts:118` destructures `note:_note`; `approval$`
  carries only `{actionId,value,ruledBy}`; the brain reads `resolution.note` it never receives). ⇒ No dedicated note
  field on the verdict buttons this pass; capture operator reasoning via the composer (`/web/say`) and flag the gap.
- **Auth surface is `signIn(email,pw)` / `register(email,pw)` / `signOut()`** + `initialize` / `onAuthStateChanged` /
  `httpClient` / `attachInterceptors` (`packages/jwt-auth/src/auth.ts:129-167`; existing `admin/login` calls
  `auth.signIn(...)`). There is **no** `login`/`logout` and **no** forgot/reset method. The stub must match this exactly.
2. **Auth = full screens + flip-ready stub.** Build the route-group + guard structure AND all 6 auth screens
   from the design, backed by a stub session (demo `dennis@atlas.dev` + any ≥8-char pw) that implements the
   `@workspace/auth` interface, so it flips to the real `/auth/*` with a one-file change when the backend lands.
3. **Data layer = TanStack Query** (+ native `EventSource` for SSE merged into the query cache). This diverges
   from the house RTK-Query/axios used in rs-crm/cubix — explicit user choice. Redux is removed from `web/`.

> ⚠️ `web/AGENTS.md`: this is **Next.js 16 with breaking changes**. Before writing code, the implementer MUST
> read the relevant guides in `web/node_modules/next/dist/docs/` (route groups, route handlers / streaming,
> async `params`/`searchParams`, `next/font`, rewrites). Do not assume Next ≤15 APIs.

---

## What we keep vs. scratch in `web/`

**Keep / reuse (config + infra):**
- `package.json` toolchain (Next 16, React 19 + compiler, Tailwind v4, dotenvx, `env:inject` script), `tsconfig.json`
  (`@/*` alias), `postcss.config.mjs`, `next.config.ts` (add `rewrites` + keep `transpilePackages`).
- `src/lib/env.ts` (extend, see §Data layer), the dotenvx `dev` flow, `@workspace/auth`, `@workspace/shared`.
- `src/lib/auth.ts` + `src/components/auth-gate.tsx` — the `auth.onAuthStateChanged` / `?next=` guard pattern is
  exactly the protected-route shape we want; refactor into the new `(auth)`/`(app)` guards.
- `src/components/plan/markdown.tsx` + `mermaid.tsx` (react-markdown + mermaid) — reuse for the Full-plan / Doc views.

**Scratch (replace wholesale):**
- All routes: `src/app/(private)/**`, `src/app/(viewer)/**`, `src/app/admin/login`, root `page.tsx`, `globals.css`.
- The entire `src/redux/**` tree + `@reduxjs/toolkit` / `react-redux` deps (TanStack Query replaces it).
- `src/lib/admin-api.ts` and the old plan/board/memory/project/token API slices.

**Add deps:** `@tanstack/react-query` (+ `@tanstack/react-query-devtools` dev), `lucide-react` (icons, matches the
Feather-style inline SVGs). Keep `axios` (used by `@workspace/auth`), `react-hook-form`, `zod`, `mermaid`,
`react-markdown`, `remark-gfm`.

---

## App structure — route groups

```
web/src/app/
├── layout.tsx                  # root: 3 fonts → CSS vars, no-flash theme script, <Providers> (QueryClient + Theme + AuthInit)
├── page.tsx                    # redirect hub: auth state → /workspace (authed) or /auth/login
├── globals.css                 # design tokens (§7) verbatim: :root + [data-theme=terminal|warm], grid bg, keyframes
├── (auth)/                     # PUBLIC group — inverse guard (authed → /workspace)
│   ├── layout.tsx              # PublicGuard + centered grid-bg auth shell + brand lockup + theme toggle
│   ├── login/page.tsx          # screens: login (+ the "loggedin"/"Enter workspace" state)
│   ├── signup/page.tsx         # signup + password strength meter
│   ├── forgot/page.tsx         # forgot-request + forgot-sent states (one route, internal state)
│   └── signed-out/page.tsx     # "You've been signed out"
└── (app)/                         # PROTECTED group — PrivateGuard
    ├── layout.tsx                 # PrivateGuard + APP-CHROME shell: TopBar + Sidebar + repo-picker + palette host
    │                              #   + {children} (main region) + {dialog} parallel slot (the create-thread modal)
    ├── @dialog/                   # parallel route slot for overlays — DRY modal host
    │   ├── default.tsx            # renders null when no modal route is active
    │   └── (.)new/page.tsx        # INTERCEPTING route → CreateThreadDialog as a popup over the current view (URL /new)
    ├── new/page.tsx               # hard-load / fallback of /new → same form full-page (shared <CreateThread/> body)
    └── workspace/
        ├── page.tsx               # Coordinator overview (no thread selected) — the board that replaces a main chat
        └── [threadKey]/
            ├── layout.tsx         # THREAD shell (DRY): Navigator (288px, real usePipeline) + work-column frame; {children}=work column
            ├── page.tsx           # default work view = Conversation (brain)
            ├── plan/page.tsx      # Full plan (plan.md — reuse markdown/mermaid)
            ├── doc/[docId]/page.tsx        # Doc view (§N · plan.md / decision-record.md) — slug
            └── phase/[phaseId]/
                ├── layout.tsx     # phase header + Transcript/Diff/Logs tab bar (DRY across tabs)
                └── [tab]/page.tsx # tab slug = transcript | diff | logs (+ auto-fix view)
```

- **Layouts = DRY containers (per feedback).** Three nested layouts own the persistent chrome so no page re-renders it:
  `(app)/layout.tsx` (TopBar/Sidebar/palette + the `@dialog` modal slot), `[threadKey]/layout.tsx` (Navigator +
  work-column frame), `phase/[phaseId]/layout.tsx` (phase header + tab bar). Work-column mode is now **folder routes +
  slugs** (`/plan`, `/doc/[docId]`, `/phase/[phaseId]/[tab]`), not search params — deep-linkable and DRY.
- **Create thread = popup (per feedback).** `+ New thread` and ⌘K push `/new`, caught by the `@dialog/(.)new`
  **intercepting route** → renders `<CreateThread/>` in a `<Dialog>` over the current view; a hard load of `/new`
  falls back to the full-page `new/page.tsx` using the **same** `<CreateThread/>` body (single source). Onboarding
  prerequisite states ("finish setup" / "connect a repo") render inside that same component when not provisioned.
- **Routing model:** `[threadKey]` is an **encoded surface coordinate** (`encodeURIComponent(channel + '::' + threadTs)`),
  NOT `atlas_threads.id` — messages key on channel+threadTs and there is no id→coord endpoint. Decode it for the
  Conversation/history calls; resolve the real `threadId` (for `/web/pipeline`) from message `meta`. Persist
  `selectedThreadKey` + `atlas-theme` to `localStorage`. (When `/web/threads` lands, switch the segment to the stable
  id — one routing-helper change.)
- **Guards (mirror cubix `PrivateGuard`/`PublicGuard`):** client components subscribing to `auth.onAuthStateChanged`;
  render `null` until first callback (no flash), redirect unauth → `/auth/login?next=…`, show a "can't reach server"
  state on `backendUnreachable`. Add a typed route helper `src/lib/routes.ts` (plain functions, no new package —
  `@workspace/site-map` is not vendored here).

---

## Design system & theming

- **Tokens:** port README §7 **verbatim** into `globals.css` — `:root` (Daylight default) + `[data-theme="terminal"]`
    + `[data-theme="warm"]` blocks (every color/rgba exactly as listed), the radii/shadow scale (converge on `--r:7px`),
      and the grid+glow background composite. Code-highlight vars (`--c-*`) included for Diff/transcript.
- **Theme switch:** `data-theme` on `<html>`, default `daylight`, persisted `localStorage['atlas-theme']`. A tiny
  inline script in root `layout.tsx` sets the attribute pre-paint to avoid a flash. `ThemeProvider` (context) +
  segmented `ThemeToggle` (Day / Terminal / Warm).
- **Fonts:** `next/font/google` → Space Grotesk (400/500/600/700), Geist (400/500/600), JetBrains Mono (400/500/600);
  expose as `--f-disp` / `--f-ui` / `--f-mono` (the names the tokens reference).
- **Animations:** `fadeUp`, `pop`, `softpulse`, `prog`, blinking cursor — **transform-only** (handoff §5: a
  non-running timeline must never hide content; never animate opacity-from-0).
- **UI primitives** (`src/components/ui/`): `Button` (accent-gradient / ghost / danger + loading spinner+verb),
  `Field`/`PasswordField`/`StrengthMeter`, `StatusDot` (status→color+pulse), `KindBadge` (FEAT/FIX/EVENT),
  `StatusPill`, `Card`, `Spinner`, `GoogleButton` (verbatim 4-color G SVG from `Atlas Auth.dc.html`). Tailwind utilities
  driven by the CSS variables; inline-style fallbacks where a token has no utility (matches house style).

---

## Data layer (TanStack Query + SSE, frontend-only proxy)

**Same-origin proxy (kills CORS + SSE buffering without backend changes):**
- `next.config.ts` `rewrites()` maps `/web/:path*` → `${ATLAS_HTTP_URL}/web/:path*` for REST.
- SSE: a dedicated streaming **route handler** `src/app/web/events/route.ts` that `fetch()`es upstream
  `${ATLAS_HTTP_URL}/web/events?channel=…` and returns `new Response(upstream.body, { headers: text/event-stream,
  'cache-control': no-cache, connection: keep-alive })` — pipes the stream so Next never buffers it. (Verify the
  Next-16 route-handler streaming API against `node_modules/next/dist/docs/` first.)
- `ATLAS_HTTP_URL` = new **server-only** env (default `http://localhost:4002`) in `src/lib/env.ts`. Browser always
  talks same-origin (`/web/*`), so there is no CORS dependency and no `NEXT_PUBLIC_` leak of the backend URL.

**Client layer (`src/lib/api/`):**
- `types.ts` — mirror backend contracts: `WebOutboundMessage` (incl. `meta`), `WebApprovalCard` / `WebVerdictCard` /
  `WebCardAction` (from `backend/.../web-approval-card.ts`), action-id constants (`atlas_approval:approve|request_changes|deny`),
  the real `PipelineState` shape (`{jobId,title,kind,status,decisionRecordId,sections:[{id,ordinal,brief,status}]}` —
  **no `pr_url`/branch/diff**), and the **ideal-but-unbuilt** `WebThreadSummary` (`{ threadKey, channel, threadTs,
  threadId?, title, kind, status, branch, tracker, meta }`) — marked contract-ahead.
- `client.ts` — thin typed `fetch` wrapper over the same-origin `/web/*` (`ping`, `channels`, `thread`, `pipeline`,
  `say`, `approve`).
- `queries.ts`:
    - `useThreadList(channel)` — **demo/live-outbox-only** derivation: `GET /web/thread?channel=` → group outbound posts
      by thread root (`ts`/`threadTs`), title from the first post, status inferred from approval/verdict cards +
      `build_event` meta. Loudly flagged in UI copy + BACKEND_GAPS as *not* the persisted thread set; first tries ideal
      `GET /web/threads` and uses it if present.
    - `useThread(channel, threadTs)` — hydrate history by fetching the **whole channel** (`GET /web/thread?channel=`)
      and coalescing `m.ts === threadTs || m.threadTs === threadTs` (so the root/headline post isn't dropped). Atlas
      **outbound only** — the human's own messages are not returned by history or SSE, so `useSay` **optimistically
      appends** the sent user bubble into this cache (keyed by the returned `ts`); never reconciled away.
    - `usePipelineOutline(channel, threadTs)` — **derived, not `/web/pipeline`** (the client has no `threadId`; see
      Hard-realities). Reconstructs a partial section/phase outline from `build_event` meta on the stream + job state
      inferred from approval/verdict cards. When `threadId` exposure / `/web/threads` lands, swap to a real
      `usePipeline(threadId, teamId)` against `GET /web/pipeline` — one hook change.
    - `useSay()` / `useApprove()` — mutations. `useApprove` submits `{actionId,value,ruledBy}`; **note is NOT plumbed by
      the backend**, so the verdict buttons carry no note field — operator reasoning goes through the composer (`/web/say`).
- `events.ts` — `useChannelEvents(channel)`: opens `EventSource('/web/events?channel=…')`, upserts each
  `WebOutboundMessage` into the `useThread` cache **by `ts`** (handoff §6.3: an edited card re-emits same `ts`).
- `classify.ts` — `classifyMessage(msg)`: `card.type==='approval_card'|'verdict_card'` → card bubbles; else inspect
  `text` prefixes the brain emits to pick decision / system-event / park-and-ask / PR-card / plain bubbles, with a
  plain-text fallback. (Robust typing needs structured message metadata — flagged in BACKEND_GAPS.)

**Auth (flip-ready stub):** `src/lib/auth.ts` exports an object matching the **actual** `@workspace/auth` surface —
`signIn(email,pw)` / `register(email,pw)` / `signOut()` / `initialize()` / `onAuthStateChanged()` / `httpClient` /
`attachInterceptors()` (NOT `login`/`logout`; the existing `admin/login` already calls `auth.signIn`). When
`NEXT_PUBLIC_AUTH_MODE==='real'` it instantiates `new Auth(...)` against the future `/auth` base; otherwise a
`localStorage`-backed stub accepting the demo creds and mocking the Google + signup + signout loading→success states.
**Forgot/reset has no package method** — it's a pure client-side stub this pass (flagged: real auth needs a reset
route). Guards/screens consume only the shared interface, so flipping is one file.

---

## Screen build (against the design files — `Atlas Workspace.dc.html` is the pixel source of truth)

1. **Auth** (`(auth)/*`, ref `Atlas Auth.dc.html`): brand lockup, 6 screen states, Google button, email/password
   with show/hide + Forgot link, strength meter, error banner, validation (email regex, ≥8-char pw, name required),
   loading verbs. Backed by the stub; `Enter workspace` → `/workspace`.
2. **App shell** (`(app)/layout.tsx`, ref Workspace): 52px TopBar (lockup→Coordinator, repo picker chip, ⌘K palette
   trigger, theme segmented control, "your key" pill, avatar) + 240px Sidebar (＋New thread, Overview+count, THREADS
   list with status dot/kind badge/mono meta, active=accent-soft). Backdrop-blur `--panel`.
3. **Coordinator overview** (`workspace/page.tsx`): heading + 2-col grid of thread cards (from `useThreadList`).
4. **Thread workspace** (`workspace/[threadKey]/…`):
    - **Navigator (288px)** — header (kind badge, status pill, title, branch+tracker mono) + **state-driven body**
      driven by `usePipelineOutline` (**derived** from `build_event` meta + approval/verdict cards, NOT `/web/pipeline`):
      running/paused→pipeline tree (Conversation node, CONTEXT group, PIPELINE §N with live status dots/progress as far
      as the stream reveals); scoping→"PLANNING IN THE CONVERSATION"; awaiting_approval→proposed sections (from the
      approval card); done→ARTIFACTS; triaging→EVENT explainer. *(Authoritative section statuses, decision record, and
      done-state artifacts — PR/branch/diff — are NOT available; those nodes show a "needs /web/threads" degraded state, flagged.)*
    - **Work column — Conversation mode** (fully wireable now): centered 760px stream rendering bubble types via
      `classifyMessage` — user (optimistic, from `useSay`) / Claude / decision chip / system-event pill / **approval
      card** (Approve / Request changes / Deny → `useApprove`, repaint same-`ts` on verdict) / **park-and-ask** / **PR
      card** / live indicator; Composer → `useSay` (no `threadTs` starts a thread; recognized phrases run the same ops
      as buttons; Request-changes/Deny reasoning is typed here since the card carries no note).
    - **Work column — Phase mode** (now nested **routes**, navigator switches via links): `/plan` (Full plan, reuse
      markdown/mermaid) + `/doc/[docId]` (Doc view) render from message content; `/phase/[phaseId]/[tab]` (Build phase —
      Transcript/Diff/Logs tab slug, interject bar, queued chips) and Auto-fix 3-lens cards are **built to the ideal
      contract but placeholder-backed** (no per-phase transcript/diff/logs endpoint yet) — flagged.
5. **Create Thread** (`<CreateThread/>` shown in the `@dialog` modal + `/new` fallback, ref `Atlas Create Thread.dc.html`):
   repo + searchable-branch picker, optional first-message textarea, composer → `useSay` then route to the new thread
   (close modal); plus the two onboarding empty states ("finish setup", "connect a repo") rendered in-component when not
   provisioned. Repo/branch list + onboarding status have no API → static/placeholder, flagged.
6. **Command palette** (⌘K, host in `(app)/layout.tsx`): overlay + filtered thread search over `useThreadList`; `esc` closes.

---

## Backend gaps to document (`web/BACKEND_GAPS.md`, no backend code this pass)

1. **`GET /web/threads` (+ `:id`) structured, persisted read model — the biggest gap.** Today `/web/thread` +
   `/web/channels` read only the in-memory, **outbound-only** `outbox`: no persisted `atlas_threads`, no threads
   without current outbox, and **no human inbound messages**. The sidebar/Coordinator are demo-only until this exists.
2. **History omits the user's own messages AND drops the thread root.** `/web/thread` returns Atlas posts only (inbound
   never stored), and `?threadTs=` filters `m.threadTs===threadTs` so the root post (whose `ts` *is* the threadTs) is
   omitted. Fix: store inbound + include the root in thread filters. (We work around both client-side.)
3. **`threadId` is unobtainable from `/web/*`, so `/web/pipeline` is unreachable.** `/web/say` returns only `{ts}`; the
   bridge keeps `atlas_threads.id` internal; message `meta` lacks it. Expose `threadId` (in the `/web/say` response or
   message meta) or ship `/web/threads`. Until then sections/decision-record/pipeline cannot be rendered authoritatively.
4. **`getPipelineState` omits `pr_url`, branch, and diff** (`driver-store.service.ts:191`) — done-state ARTIFACTS
   (the PR card, branch link, file diff) have no read model. The controller's `pr_url` comment is inaccurate.
5. **`POST /web/approve` drops `note`** — it's accepted then discarded before `approval$`; the brain's request-changes
   copy reads a `resolution.note` it never gets. Plumb `note` through `approval$`/`resolve` to support verdict reasons.
6. CORS on `backend/src/atlas-main.ts` (`app.enableCors({ origin, credentials })`) — needed only if the team prefers a
   direct browser→:4002 connection over our same-origin proxy.
7. Production resume route `POST /web/resume { jobId }` (replaces ops-only `POST /test/resume`).
8. `/auth/*` (session / login / register / signout / Google OAuth **and a forgot/reset route** — none in `@workspace/auth`
   today) — the design Auth screens are the contract.
9. Per-phase read endpoints: phase transcript, diff, logs, auto-fix lenses (even job+section state is unreachable today
   since `/web/pipeline` needs a `threadId` the client can't get — see #3).
10. Repo/branch listing + engine-credential / repo-connection status for Create-Thread onboarding states.
11. Structured message typing (decision / event / PR / park) so the client doesn't string-sniff `text`.

---

## Critical files

**Create:** `web/src/app/{layout,page,globals.css}.tsx`, `(auth)/{layout,login,signup,forgot,signed-out}`,
`(app)/layout.tsx`, `(app)/@dialog/{default,(.)new/page}.tsx`, `(app)/new/page.tsx`, `(app)/workspace/page.tsx`,
`(app)/workspace/[threadKey]/{layout,page}.tsx` + `{plan/page, doc/[docId]/page, phase/[phaseId]/layout,
phase/[phaseId]/[tab]/page}.tsx`, `web/src/app/web/events/route.ts` (SSE proxy), `web/src/lib/{routes,api/{types,client,
queries,events,classify}}.ts`, `web/src/components/{ui,shell,coordinator,thread,conversation,phase,create,auth,theme}/*`
(incl. `create/CreateThread.tsx` shared by modal + fallback), `web/src/providers.tsx`, `web/BACKEND_GAPS.md`.
**Modify:** `web/src/lib/{env,auth}.ts`, `web/next.config.ts` (rewrites), `web/package.json` (deps), refactor
`web/src/components/auth-gate.tsx` → guards.
**Delete:** `web/src/redux/**`, `web/src/lib/admin-api.ts`, old `(private)`/`(viewer)`/`admin` routes.
**Reuse:** `web/src/components/plan/{markdown,mermaid}.tsx`.

## Verification

1. **Static:** `pnpm -C web typecheck` and `pnpm -C web build` clean (React-compiler + Tailwind v4).
2. **Backend up:** from `backend/`, `ATLAS_SURFACE=web ATLAS_HTTP_PORT=4002 pnpm atlas:dev` (+ `db:atlas:migrate`),
   `curl localhost:4002/web/ping` → `{ ok:true, surface:"web" }`. (Ask before starting any dev server — per house rule.)
3. **Frontend:** `pnpm -C web dev`; confirm proxy: browser `GET /web/ping` 200 same-origin; SSE
   `GET /web/events?channel=…` stays open + streams (no buffering).
4. **End-to-end happy path:** stub-login → Coordinator lists threads → open a thread → Conversation hydrates
   (`/web/thread`) + live updates (SSE upsert by `ts`) → Composer posts (`/web/say`) → approval card Approve
   (`/web/approve`) repaints to verdict in place → start a new thread from `/new`.
5. **Theme + a11y:** Day/Terminal/Warm swap with no flash on reload (persisted); `⌘K` palette + `esc`; keyboard auth flow.
6. **Feel:** Dennis validates conversational/UX feel himself (no self-billed behavior runs).