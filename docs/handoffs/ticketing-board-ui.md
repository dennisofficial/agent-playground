# Designer handoff — Atlas Tickets (Board + Backlog)

**For:** the UI prototype. **Status:** backend Phases 1–2 are built, tested, and live behind the API
below (Phase 3 wired Atlas's own tools). This brief is everything you need to design the operator-facing
board/backlog. No code expected back — mockups/prototype first; we wire it after.

---

## 1. What this is (context)

Atlas works on **repos**; each conversation is a **thread** on a repo. Until now there was nowhere to
put work that surfaces mid-conversation but is out of scope ("do A now, push B for later") — the operator
had to remember it. **Tickets** are that place: a lightweight, durable per-repo **board + backlog** that
Atlas can capture into during a conversation and later **promote** into a real working thread.

A ticket is **not** a thread. A thread owns a sandbox/branch/PR (heavy); a ticket is just captured intent
(cheap). The payoff is an *actionable* backlog: Atlas adds tickets while you talk, and one click (or one
Atlas action) turns a ticket into a thread that starts working it.

This is **internal** (our own board) — not Jira. Don't design Jira-import/sync surfaces; that's a future
consideration.

## 2. Where it lives

Per-repo, alongside the existing thread navigator. A repo has **Threads** (today) and now **Tickets**.
Suggest a repo-level switch between **Threads** and **Tickets**, with Tickets offering two views:

- **Board** — kanban columns: `Todo → In progress → In review → Done` (drag between columns).
- **Backlog** — a triage list of everything in `backlog` status (the holding pen, not yet on the board),
  plus a way to see `cancelled`.

`backlog` is deliberately *off* the board (it's the inbox/triage). Moving a ticket from Backlog → Todo is
"committing" it to the board. An org-wide cross-repo board is **out of scope** for now (it's a later
aggregation) — design for one repo.

## 3. Surfaces to design

1. **Board view** — columns by status; cards show `#number`, title, priority, kind, a "blocked" indicator,
   and an "in a thread" indicator when linked. Drag = status change.
2. **Backlog list** — triage list (status `backlog`), sortable, with quick "move to Todo / set priority".
3. **Ticket card** (compact, on board/list) and **Ticket detail / drawer** (full).
4. **Create / edit ticket** — title (required), body (markdown, the context), priority, kind, status,
   dependencies.
5. **Dependency display** — "Blocked by #14 (Title)" and "Blocks #20". Dependencies are **advisory**: show
   the relationship and a derived `blocked` flag; nothing auto-moves. A ticket is `blocked` when any ticket
   it depends on is not yet `done`/`cancelled`.
6. **Thread ⇄ ticket link** — on a ticket: **Promote to thread** (when none) / **Working in thread …**
   (deep-link, when linked). On a thread: a small "Working ticket #14" chip. The link is **1:1** (a ticket
   has at most one thread).
7. **Provenance** — a ticket shows where it came from: "Captured from thread *<title>*" and, if relevant,
   "Diverged from decision: *<summary>*". (We snapshot this text at capture so it survives even if the
   source thread is later deleted.)

## 4. Enums (exact values)

- **status:** `backlog` · `todo` · `in_progress` · `in_review` · `done` · `cancelled`
- **priority:** `low` · `medium` · `high` · `urgent` (nullable — design a "no priority" state)
- **kind:** `feature` · `bug` · `chore` (nullable)

## 5. States to cover (don't skip these)

- **Empty backlog** — first-run; explain that Atlas can capture tickets during a conversation, plus a manual
  "New ticket" affordance.
- **Empty board** — backlog has items but none committed yet.
- **Blocked ticket** — clearly marked; show what it's blocked by.
- **Ticket with an active thread** — "Working in thread …", promote disabled/replaced.
- **Done / cancelled** — visually de-emphasized; cancelled distinct from done.
- **Atlas-created vs human-created** — subtle marker (most tickets will be Atlas-captured).
- **Long titles / no body / no priority** — graceful.

## 6. Realtime

The board is live. The existing per-repo SSE stream emits a `ticket_event`
(`{ type: 'ticket_event', ticketId, kind: 'created' | 'updated' | 'deleted' }`) on every change —
including when **Atlas** mutates a ticket mid-conversation. The client should reflect changes without a
manual refresh (the web app pattern is TanStack Query invalidate-on-event). Design for cards appearing /
moving / updating live while the operator watches.

## 7. API contract (already built)

Base: `/web/orgs/:orgId/repos/:repoId/tickets` (cookie auth + org membership; any member can read/write —
the board is collaborative, not owner-gated).

| Method | Path | Purpose |
|---|---|---|
| GET | `/tickets?status=&q=` | list (filter by status; `q` matches title/body) |
| POST | `/tickets` | create `{ title, body?, priority?, kind?, status?, dependsOn? }` |
| GET | `/tickets/:id` | detail (+ dependencies + `blocked` + `linkedThreadId`) |
| PATCH | `/tickets/:id` | edit `{ title?, body?, status?, priority?, kind?, sortOrder? }` |
| DELETE | `/tickets/:id` | delete |
| POST | `/tickets/:id/dependencies` | add edge `{ dependsOnTicketId }` |
| DELETE | `/tickets/:id/dependencies/:depId` | remove edge |
| POST | `/tickets/:id/promote` | promote → `{ threadId, created }` (idempotent) |

**Ticket shape (list/detail):**
```jsonc
{
  "id": "uuid",
  "number": 14,                       // per-repo, human-friendly (#14)
  "title": "Editable subdomain rename in Network tab",
  "body": "markdown…",                // nullable
  "status": "backlog",
  "priority": "high",                 // nullable
  "kind": "feature",                  // nullable
  "sortOrder": 0,                     // drag-order within a column
  "originThreadId": "uuid|null",
  "originDecisionRecordId": "uuid|null",
  "origin": { "threadTitle": "…", "decisionSummary": "…" }, // provenance snapshot, nullable
  "createdAt": "…", "updatedAt": "…",
  // detail only:
  "blocked": true,
  "linkedThreadId": "uuid|null",      // the thread working it (1:1)
  "dependsOn": [{ "id", "number", "title", "status" }],  // what blocks this
  "blocks":    [{ "id", "number", "title", "status" }]   // what this blocks
}
```

## 8. Interaction notes / guardrails (from the backend rules)

- **Dependencies are advisory.** No auto-promote when a blocker resolves — don't design automation around
  it. Cycles are rejected by the API (a ticket can't transitively depend on itself); surface that as an
  inline validation error.
- **Promote is idempotent.** Promoting an already-linked ticket just returns the existing thread — the
  button should read "Working in thread …" once linked, not create a second thread.
- **Numbers are per-repo** (`#14`), assigned at create. Use them in dependency chips and references.
- **Drag = PATCH status** (and/or `sortOrder` for in-column ordering).

## 9. Out of scope for this prototype

External board sync (Jira/Linear/GitHub Issues), org-wide cross-repo board, and any dependency-driven
automation. Keep it to one repo's board + backlog + the thread link.
