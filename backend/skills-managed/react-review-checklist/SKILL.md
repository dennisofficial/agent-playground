---
name: react-review-checklist
description: React/Next.js conformance rules for reviewing frontend changes — hook dependencies, list keys, effect cleanup, and render-time purity. Applied by the framework-conformance review lens on frontend threads.
review_for_types: [frontend]
metadata:
  trigger: Reviewing a React/Next.js change for framework-conformance defects
  version: 1.0.0
---

# React / Next.js review checklist

Enforce these rules when reviewing a React or Next.js change. Flag a violation only when the changed
code actually breaks a rule below; cite the rule by name and give the concrete fix. These are
conformance rules, not style preferences — a violation is a real defect a senior React engineer would
block in review.

## Rules

- **No array index as a list key.** Rendering a list with `key={index}` (or `key={i}`) breaks
  reconciliation when the list reorders, inserts, or deletes — React reuses the wrong DOM/state.
  Use a stable, item-derived id (`key={item.id}`). Only an append-only, never-reordered static list
  may use the index, and even then a real id is preferred.

- **Exhaustive hook dependencies.** `useEffect` / `useMemo` / `useCallback` must list every reactive
  value they read (props, state, context, derived values). A missing dependency causes stale closures
  and skipped re-runs. If a value is intentionally excluded, that is a code smell to justify, not omit.

- **Clean up effects that subscribe.** An effect that adds an event listener, opens a
  subscription/interval/timeout, or starts an async watcher MUST return a cleanup function that tears it
  down. A missing cleanup leaks listeners and fires state updates after unmount.

- **No side effects during render.** The render body (and the top level of a function component) must be
  pure: no mutation of external state, no data fetching, no subscriptions, no `ref` writes. Side effects
  belong in `useEffect`/event handlers. A fetch or mutation in render re-runs on every render.

- **Do not call hooks conditionally.** Hooks must run in the same order every render — never inside a
  condition, loop, early return, or nested function. A conditional hook corrupts React's hook state.

- **Keys belong on the outermost element returned by `.map()`.** Putting `key` on a child instead of the
  mapped root, or spreading it away, defeats reconciliation.
