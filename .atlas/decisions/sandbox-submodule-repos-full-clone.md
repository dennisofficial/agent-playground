---
id: sandbox-submodule-repos-full-clone
title: "Submodule repos get full-clone sandboxes, not linked worktrees"
status: proposed
tags: []
decided_on: 2026-07-08
authored_by: atlas
confirmed_by_operator: true
source_job: "3614de9e-8455-4534-884a-c2f782a51b14"
source_decision: "d2"
supersedes: []
superseded_by: null
governs_paths: ["backend/src/app/git/**", "backend/src/app/driver/**", "backend/src/app/sandbox/**"]
last_reconciled: 2026-07-08T18:49:10.670Z
---
# Submodule repos get full-clone sandboxes, not linked worktrees

## Context

Atlas normally provisions each sandbox as a git LINKED WORKTREE that shares the repo's main-clone object store, and at container-attach it bind-mounts the shared git-common dir plus a rebased .git pointer for the worktree and for every submodule gitlink. Because each submodule .git overlay is a SEPARATE bind mount from /workspace, any tool that hardlinks a submodule's .git into the worktree filesystem (e.g. pnpm's injected-deps sync copying packages/*) fails with EXDEV: cross-device link, and container-side submodule git is left broken. The governing requirement established here: an in-sandbox checkout must behave exactly like a normal LOCAL clone — full submodule git that works for every tool, and the ability to stage/commit a submodule pointer (hash) bump as part of a superproject commit (the two-PR submodule workflow).

## Decision

For any repo that HAS submodules (a .gitmodules at the checkout root), provision each sandbox as a normal standalone full git CLONE instead of a linked worktree. Then .git is a real directory under /workspace, submodule gitdirs live under /workspace/.git/modules/..., and the whole checkout is on the single /workspace mount — so no tool ever hits a cross-device hardlink, container-side submodule git fully works, and no host-shaped paths leak (the neutral-path boxing invariant is preserved). Repos WITHOUT submodules keep the existing efficient linked-worktree provisioning unchanged. Provisioning, teardown, and restart-recovery branch on clone-vs-worktree (clone = git clone + origin repointed to the GitHub URL + checkout feature branch + submodule update; teardown = rm -rf instead of git worktree remove). SandboxManager.attach()'s git-common mount + rebaseDotGit .git-overlay block is naturally bypassed for clones because git rev-parse --git-common-dir resolves UNDER the worktree; no attach change is required.

## Consequences

Submodule repos pay a full clone per sandbox (losing the linked-worktree shared-object-store efficiency; mitigated by cloning locally from the main clone so objects are hardlinked on the host fs). Host-side git is unchanged and still commits submodule pointer bumps normally. The git-common bind mount and the per-submodule rebaseDotGit overlays no longer apply to submodule repos. Any future change to sandbox provisioning/teardown/recovery must preserve the clone-vs-worktree branch and must not reintroduce a cross-mount .git for submodule checkouts.

## Alternatives considered

(A) Write neutral-path plain gitlinks and make host LocalGitService exclude/ignore submodules — REJECTED: it silently drops submodule pointer-bump commits from the host, breaking the two-PR submodule workflow. (B) Mount git-common at the host's absolute path inside the container so the original gitlinks resolve — REJECTED: leaks host-shaped paths into the engine, breaking the neutral-path boxing invariant. (C) A pnpm-specific build-script workaround that unmounts/materializes the gitlinks — REJECTED: per-package-manager, unmaintainable, and doesn't fix the root cause for other tools (yarn, etc.).
