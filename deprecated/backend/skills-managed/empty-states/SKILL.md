---
name: empty-states
description: Design empty, error, and loading states that teach and guide instead of showing a blank screen. Use whenever building or reviewing any list, table, grid, detail pane, tab, kanban, calendar, search result, feed, inbox, or dashboard that can render with no data — or when the user mentions "empty state," "no data," "zero results," "no results found," "nothing here," "first run," "blank screen," "error state," "loading state," "skeleton," or onboarding for a feature's first use.
metadata:
  trigger: Building or reviewing any data view's empty, error, or loading state
  version: 1.0.0
---

# Empty States

An empty state is the user's first impression of a feature. A blank screen tells them nothing is wrong — so they assume the feature is broken or pointless. Treat every empty, error, and loading surface as designed UI, not a fallback.

## When this applies

Any screen that can render with no data: lists, tables, grids, detail panes, sub-tabs, kanban columns, calendars, search/filter results, feeds, inboxes, dashboards. If you build or review one, you own its empty, error, and loading states too.

## The four kinds of "empty" — design each one distinctly

Never ship one generic "No X found" for every case. They mean different things and need different copy and different actions:

1. **First run** — the user has never created any X. This is your best onboarding moment. Teach what the feature does in one sentence, and give the primary action to create the first one.
2. **No results** — a search or filter returned nothing. Reflect the query ("No tickets match 'roof'") and offer to clear the search. Never reuse first-run copy here.
3. **Error** — the fetch failed. Say so plainly and human, and give a real Retry button — not just "Please try again" text.
4. **Filtered out** — everything is hidden by an active filter or toggle. Point at the filter and offer to reset it.

If a component can't tell these four apart, it isn't finished.

## The five rules

1. **Illustration.** Include an icon or illustration. A blank screen reads as "nothing is wrong." Use the entity's icon, or a state icon (a document-X for no-data, a warning glyph for errors).
2. **Human copy.** Sound like a product, not a log line or a corporate notice. Not "Something went wrong loading your data." Prefer "We couldn't load your tickets." Short, warm, specific.
3. **Primary action.** Every empty and error state needs the one next step as a real button — "Create ticket," "Invite teammate," "Retry," "Clear filters." A button elsewhere on the page does **not** count; the action belongs _inside_ the empty state. Only exception: a passive "select a row to preview" pane.
4. **Type distinction.** Render the right one of the four kinds above. One message for all four is the single most common failure.
5. **Teach.** Use first-run empties to explain what the feature does before the user touches it — one line of value, not just "No X found."

## Reviewing an existing state

For each empty/error/loading surface, check:

- [ ] First-run: icon, human copy, teaches the feature, primary "create" action.
- [ ] Search/filter zero: distinct copy referencing the query + a "clear filter" action.
- [ ] Fetch error: distinct error UI with a working **Retry**.
- [ ] Loading: skeleton or spinner, not a blank frame or bare "Loading…".
- [ ] Copy reads like a product, not a log line.

## Building them well

- Reuse one shared set of primitives (e.g. `EmptyState` / `ErrorState` / `LoadingState`) rather than hand-rolling per screen. Give them an `action`/`onAction` prop and a `variant` (`first-run` | `no-results` | `filtered` | `error`) so a single design pass propagates everywhere.
- Prefer skeleton loaders that mirror the real layout over a centered spinner — they cut perceived latency and avoid layout shift.
- Keep copy in the same voice as the rest of the product; if there's a brand/voice guide, the empty state follows it.

If the current project ships its own empty-state skill or component map, load that too for the specific components and known gaps.
