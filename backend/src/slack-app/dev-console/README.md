# Dev console — drive Atlas from the terminal

A **dev-only** seam that lets an agent (Claude Code) or Dennis drive and observe the orchestrator
bot **Atlas** from a terminal CLI — the same way Dennis drives Atlas in Slack, but scriptable and
isolated. Use it to **self-validate harness behavior**: create a fresh Atlas thread, send a message,
and read back the gate decision, tool calls, sessions opened (+ their reports), and cost.

> If you're a future session: this is the thing to reach for instead of asking Dennis to screenshot
> Slack. It exercises the *real* Atlas (shared employees / memory / projects), just through HTTP.

## Enable it (one-time, dev only)

It is mounted **only** when `DEV_CONSOLE_ENABLED` is set, behind a token — never reachable in prod.
Add to `backend/.env.personal`:

```
DEV_CONSOLE_ENABLED=1
DEV_CONSOLE_TOKEN=<any-dev-secret>
```

then (re)start the harness: `pnpm slack:dev` (from `backend/`). The CLI reads the same env, so run it
through the `atlas` script (which injects env):

## Use it

```bash
pnpm atlas new [--project <id>] [--team <id>]   # start a fresh, clean thread (remembers it)
pnpm atlas say "<message>"                        # send as a user; waits for + prints Atlas's reply + trace
pnpm atlas tail                                   # stream the current thread's activity live
```

Example (validating cross-project referencing):

```bash
pnpm atlas new --project ai-crew
pnpm atlas say "spin up a workspace here, then read how cubix-infra does admin portals"
```

You'll see, in the terminal: `gate: respond`, the `create_workspace` and
`investigate({references:[…]})` tool calls, the session open + its report, Atlas's reply, and the cost.

### What you can / can't see
- **Can:** `gate` (respond/skip), `tool` (name), `message`, `reaction`, `recall`, `draft`, `usage`/cost
  off the conductor event bus; **sessions** (status, mode, task, lastReport) off `SESSION_REGISTRY`,
  with tool-call **detail** (args/results) available via the session transcript (`progress(id)`).
- **Can't:** judge Slack-native rendering (card layout, emoji, avatars) — that stays Dennis's eyes.
  Tool **arguments** for Atlas's own chat-surface calls come from the session transcript, not the
  name-only `tool` event.

## How it works (why it's shaped this way)

Two constraints drove the design:
1. **One process** composes the harness (the conductor is the sole writer of the channel/cursor
   tables), so the console must inject into the **running `slack-app`**, not boot its own instance.
2. The `CHAT_SURFACE` seam is **single-surface** (one DI token), so a second adapter alongside Slack
   would mean refactoring a load-bearing seam.

So instead of a second surface, it drives Atlas **out-of-band** on a dedicated `console:*` channel:
- **Inject:** `ConductorService.submitFrom(...)` — the normal inbound path, gate and all. A fresh
  thread = a fresh `console:<id>` channelId, registered up front (team/project/members) so the project
  binds before the first message.
- **Observe:** subscribe to `ConductorEventsBus.events$` (channel-scoped — see Phase 0 below) + tap
  `SESSION_REGISTRY.onUpdate`. The Slack adapter ignores `console:*` outbound for free
  (`parseSlackSurface` → undefined), so console turns never leak into Slack and vice-versa.
- **Settled:** per-channel — a turn is done once its channel has been quiet for a debounce after at
  least one event landed (NOT the global `status.thinking`, which is process-wide). Async session
  relays that arrive later keep streaming; see them with `pnpm atlas tail`.

### Phase 0 — channel-scoped events (a prerequisite that lives outside this folder)
For per-thread attribution, the conductor's turn-emitted observability events
(`tool`/`usage`/`recall`/`draft`) now carry `channelId`, and a `gate` event (`respond|skip` +
channelId) is emitted from the turn. See
[`domain/conductor-events.ts`](../../harness/domain/conductor-events.ts) and the emit sites in
[`conductor/conductor.service.ts`](../../harness/conductor/conductor.service.ts) (search `kind: 'gate'`).

## Files
- `dev-console.service.ts` — inject (`say`) + observe (`events`) + `newThread`; the buffer + settle logic.
- `dev-console.controller.ts` — `POST /dev/console/threads|say`, `GET /dev/console/events`; token guard.
- `dev-console.module.ts` — mounted by `SlackAppModule` only when `DEV_CONSOLE_ENABLED`.
- `cli/atlas-console.ts` (+ the `atlas` package script) — the terminal client.

## Gotchas
- The harness must be **running** with `DEV_CONSOLE_ENABLED` (the CLI talks to `localhost:$PORT`,
  default `4001`).
- `investigate` no longer auto-opens a workspace — drive Atlas to `create_workspace` first (or the
  reply will say to).
- `--team` defaults to `HARNESS_TEAM_ID` then `local`; point it at the team your projects are
  registered under (the Slack tenant) when testing real projects.
- Console threads are ephemeral conversation state; they share the same DB, employees, memory, and
  projects as Slack, so don't run destructive flows you wouldn't run in the real channel.
