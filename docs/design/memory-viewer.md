# Memory Viewer — Design Spec

## Purpose

The memory viewer is a read-only admin page at `/admin/memory` where Dennis can inspect what each AI agent knows. Think of it as "looking inside an agent's brain" — browsing the facts they hold, grouped in a way that makes sense, with full visibility into what's active vs. what's been forgotten.

This is a personal tool for Dennis, not a public-facing UI. No editing, no deletion, no writing — read-only only.

---

## Mental Model

Each agent holds facts at different scopes. A fact is something the agent was told or learned, stored with a tier (how broadly it applies) and optionally a project (which codebase it belongs to). The viewer organizes facts by **who holds them** (which agent) and **how broadly they apply** (tier).

**Important:** "Navigate by agent" means filtering by the agent whose memory you're inspecting — technically the `botId` extracted from the fact's scope string (e.g. `bot:alex`, `pair:alex:dennis`). This is different from `asserted_by`, which is the human who stated the fact. The server resolves this distinction before sending data to the client.

---

## Information Architecture

### Primary Navigation — By Agent

A sidebar or dropdown lists all agents: Sam, Alex, Riley, Maya, James, Nora. Selecting an agent loads their facts.

Default selection: the first agent alphabetically, or the last-viewed agent if stored in local state.

### Secondary Navigation — By Tier (Tabs)

Within a selected agent, facts are grouped into four tabs:

- **Project** — facts scoped to a specific project (`project:` tier). Each fact shows which project it belongs to.
- **Team** — facts shared across the whole team (`team:` tier).
- **Bot** — facts personal to this agent, not shared (`bot:` tier).
- **Private** — facts from 1:1 DM conversations (`pair:` tier). These are clearly labeled as private and show the human participant.

Tab labels show the count of active facts: e.g. `Project (12)`. If forgotten facts exist in a tier, a muted hint appears: `Project (12) · +3 forgotten`.

### Forgotten Facts Toggle

A toggle above the fact list: `Show forgotten facts` (off by default).

When off: only active facts are shown. The `(+N forgotten)` hints on tabs indicate forgotten facts exist without cluttering the view.

When on: forgotten facts appear in the list with a `Forgotten` badge, visually muted (lower opacity or strikethrough on the content). They appear after active facts within each tier.

### Search

A text input filters the currently loaded facts (client-side substring match on fact content). Scoped to the current agent + tier view. No server roundtrip needed at this scale.

Placeholder: `Search [Agent]'s memories…`

---

## Fact Display

Each fact renders as a row in a list. Keep it scannable — this is a list view, not a detail view.

**Every fact shows:**
- Fact content (the text of the fact) — full text, no truncation
- Tier badge — colored pill: `project` / `team` / `bot` / `private`
- Created date — relative time (e.g. "3 days ago"), full date on hover

**Conditionally shown:**
- **Project name** (project-tier facts only) — muted label beneath the content
- **Private participant** (pair-tier facts only) — e.g. "Private · with Dennis", muted
- **Forgotten badge** — only when show-forgotten is on and the fact is soft-deleted
- **Confidence** — only when < 1.0, shown as a muted percentage (e.g. `82% confidence`)

**Not shown:** raw scope strings, embedding vectors, internal IDs, `asserted_by` (the human who stated the fact — this is an internal detail, not useful in the viewer UI)

---

## Empty and Error States

- **No facts in a tier:** "No [tier] memories yet." — simple, no illustration needed
- **No facts at all for an agent:** "No memories recorded for [Agent] yet."
- **Search returns nothing:** "No memories matching '[query]'." with a clear/reset link
- **Load error:** "Couldn't load memories — try refreshing." with a retry button
- **Loading:** skeleton rows matching the fact row height

---

## Out of Scope (v1)

- Editing or deleting facts from the UI
- Creating new facts
- Semantic/vector search (client-side substring is enough)
- Cross-agent memory comparison
- Bulk operations
- Export

---

## API Contract (Hint for Alex + Riley)

The frontend needs one endpoint:

```
GET /tenants/:teamId/memory/facts?botId=&tier=&includeDeleted=
```

Response: array of fact objects, each with:
- `id`
- `content` — the fact text
- `tier` — `project` | `team` | `bot` | `private` (parsed server-side from scope)
- `botId` — which agent this fact belongs to
- `projectId` — project slug/id if tier is `project`, otherwise null
- `humanId` — the other participant if tier is `private`, otherwise null
- `confidence` — float 0–1, omit or null if 1.0
- `deletedAt` — timestamp if soft-deleted, otherwise null
- `createdAt` — timestamp

The server parses scope strings into these fields — the client never sees a raw scope string.

`teamId` is read from `NEXT_PUBLIC_TEAM_ID` env var on the frontend (single-tenant, no dropdown needed).

---

## Route + File Placement

- Route: `/admin/memory`
- File: `apps/web/app/admin/memory/page.tsx`
- Follows the existing Next.js App Router structure
