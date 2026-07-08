# ADR 0006 — Submodule repos get full-clone sandboxes, not linked worktrees

- **Status:** Accepted — implemented.
- **Date:** 2026-07-08

## Context

Atlas normally provisions each sandbox as a git LINKED WORKTREE that shares the repo's main-clone object
store, and at container-attach it bind-mounts the shared git-common dir plus a rebased `.git` pointer for
the worktree and for every submodule gitlink. Because each submodule `.git` overlay is a SEPARATE bind
mount from `/workspace`, any tool that hardlinks a submodule's `.git` into the worktree filesystem (e.g.
pnpm's injected-deps sync copying `packages/*`) fails with `EXDEV: cross-device link`, and container-side
submodule git is left broken. The governing requirement: an in-sandbox checkout must behave exactly like a
normal LOCAL clone — full submodule git that works for every tool, and the ability to stage/commit a
submodule pointer (hash) bump as part of a superproject commit (the two-PR submodule workflow).

## Decision

For any repo that HAS submodules (a `.gitmodules` at the checkout root), provision each sandbox as a
normal standalone full git CLONE instead of a linked worktree. Then `.git` is a real directory under
`/workspace`, submodule gitdirs live under `/workspace/.git/modules/...`, and the whole checkout is on the
single `/workspace` mount — so no tool ever hits a cross-device hardlink, container-side submodule git
fully works, and no host-shaped paths leak (the neutral-path boxing invariant is preserved). Repos WITHOUT
submodules keep the existing efficient linked-worktree provisioning unchanged.

`LocalGitService.hasSubmodules(repo)` drives the branch (a `.gitmodules` check at `origin/<defaultBranch>`
via `readFileAtRef`). Provisioning, teardown, and restart-recovery branch on clone-vs-worktree:

- **Provisioning:** `createBaseClone` is the clone-mode analogue of `createBaseWorktree` — it lands at the
  same per-thread path (`<repoPath>/.worktrees/thread-<jobId>`), local-clones the main clone (objects
  hardlinked on the host fs, so it's fast), repoints `origin` at the real GitHub URL, fetches the fresh
  base, and detaches on it.
- **Branch switch / recovery:** `switchBranch` now checks the LOCAL ref inside the checkout itself (not
  the main clone), so it works for both modes. For a clone whose local feature branch is missing (e.g. the
  sandbox was reset), it first tries to restore the branch from `origin` (its commits were already pushed)
  before cutting a fresh one off the base.
- **Teardown:** `removeSandbox` detects a clone (`.git` is a real directory, not a gitlink) and `rm -rf`s it
  outright instead of `git worktree remove`.

`SandboxManager.attach()`'s git-common mount + `rebaseDotGit` `.git`-overlay block is naturally bypassed for
clones because `git rev-parse --git-common-dir` resolves UNDER the worktree — no attach change is required.

## Consequences

**Positive:** submodule repos get fully working in-sandbox submodule git — every tool (pnpm, yarn, git
itself) sees a normal local clone, and the two-PR submodule pointer-bump workflow keeps working. No
host-shaped paths leak into the container in either mode.

**Negative / costs:** submodule repos pay a full clone per sandbox, losing the linked-worktree
shared-object-store efficiency (mitigated by cloning locally from the main clone so objects are hardlinked
on the host fs, not re-fetched from GitHub). Host-side git is unchanged — it still commits submodule
pointer bumps normally. The git-common bind mount and the per-submodule `rebaseDotGit` overlays no longer
apply to submodule repos; `SandboxManager.attach()` requires no code change since its git-common block is
already conditioned on the worktree shape.

Any future change to sandbox provisioning/teardown/recovery must preserve the clone-vs-worktree branch and
must not reintroduce a cross-mount `.git` for submodule checkouts.

## Alternatives considered

- **Write neutral-path plain gitlinks and make host `LocalGitService` exclude/ignore submodules:**
  rejected. It silently drops submodule pointer-bump commits from the host, breaking the two-PR submodule
  workflow.
- **Mount git-common at the host's absolute path inside the container so the original gitlinks resolve:**
  rejected. Leaks host-shaped paths into the engine, breaking the neutral-path boxing invariant.
- **A pnpm-specific build-script workaround that unmounts/materializes the gitlinks:** rejected.
  Per-package-manager, unmaintainable, and doesn't fix the root cause for other tools (yarn, etc.).

## Status & rollout

Implemented: `LocalGitService.hasSubmodules` / `createBaseClone`, clone-aware `switchBranch` /
`removeSandbox`, and the `provisionSandbox` / `ensureWorktree` call sites in `JobLifecycleService` branching
on `hasSubmodules`. See `.atlas/decisions/sandbox-submodule-repos-full-clone.md` for the original decision
record.
