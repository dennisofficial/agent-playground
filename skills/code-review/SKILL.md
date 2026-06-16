---
name: code-review
description: Review a code change for correctness, security, and clarity before opening or approving a PR. Use when reviewing a diff, self-reviewing your own work, or deciding whether a change is ship-ready.
---

# Code review

A disciplined pass over a change before it ships. Work from the diff, not the whole repo —
review what changed and what it touches.

## Order of operations

1. **Understand the intent.** Read the PR/ticket description and the diff summary. State, in one
   sentence, what the change is supposed to do. If you can't, the description is the first problem.
2. **Correctness first.** For each changed hunk ask: does it do what it claims? Walk the new control
   flow with a concrete input. Check edge cases — empty/null, the boundary value, the error path, and
   concurrent access if shared state is touched.
3. **Security & data integrity.** Untrusted input reaching a query, a file path, a shell command, or a
   template is the highest-signal class of bug. Check authz on new endpoints, secrets never logged or
   committed, and migrations that can't lose or corrupt data.
4. **Reuse & simplification.** Is there an existing helper this duplicates? Can a branch collapse? Is
   the abstraction at the right altitude — not one-off code prematurely generalized, nor copy-paste
   that should be shared?
5. **Tests.** Does the change carry tests that would fail without it? A bug fix with no regression test
   is incomplete.

## What to report

- Lead with the few highest-confidence, highest-impact findings. Don't pad with style nits.
- For each finding: the file and line, why it's wrong (or risky), and a concrete fix.
- Separate **blocking** (correctness/security) from **non-blocking** (cleanups, preferences).
- If the change is sound, say so plainly and approve — don't manufacture objections.

## Anti-patterns to flag

- Silent failure: a caught error that's swallowed with no log and no signal to the caller.
- Broadened scope: a "drive-by" refactor mixed into a focused change, making it un-reviewable.
- Asymmetry: an `add` path updated without the matching `remove`/`update`/cleanup path.
- Off-by-one and boundary handling in new loops and slices.
