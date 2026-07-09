# ADR 0003 — Worktree config (mounts + seed) moves from committed `atlas.json` to the DB

> **Terminology note (later rename):** what this ADR calls "worktree config" was renamed to
> **workspace config** as part of unifying the whole config layer under the "Workspace Profile"
> umbrella — tool `write_worktree_config` → `write_workspace_config`, `WorktreeConfigStore` →
> `WorkspaceConfigStore`, `WorktreeSecretFileStore` → `WorkspaceSecretFileStore`, tables
> `org_worktree_*` → `org_workspace_*`. The runtime `WorktreeHydrator`/`WorktreeProvisioner` keep
> "worktree" (they act on the literal git worktree). This ADR's body is left as historical record.

- **Status:** Accepted — implemented.
- **Date:** 2026-07-02
- **Supersedes:** §5 ("Two-speed propagation") of `docs/adr/0002-onboarding-hydration-manifest-not-boot-recipe.md`, and the `driver/worktree-manifest.ts` live-hydration path it introduced.

## Context

ADR-0002 gave secrets and worktree config (mounts/seed) two different propagation speeds: secret grants live in the org+repo-scoped DB and reach every job's next hydration instantly; `atlas.json` (mounts + golden seed) is a committed file, so a `write_worktree_config` call only reaches other jobs after the authoring job's PR is reviewed, merged, and the other job's already-cut branch happens to rebase onto the merge — which nothing automates.

This was a real production hit, not a hypothetical: a job added a mount via `write_worktree_config`, and every other in-flight job on the same repo never saw it, because their worktrees were cut before the PR merged and nothing re-synced them mid-flight.

The original reasoning for keeping `atlas.json` file-based — "mounts deserve review because they shape sandbox topology" — does not hold up: the actual safety validation (path traversal, reserved-path rejection, a path-length ceiling) happens at write-time in `normalizeMounts`/`normalizeSeed` regardless of where the validated data is then stored, not via a human reviewing a git diff. Secrets already work this way with no review gate. And mounts/seed were never consumed as a *file* by any process — they are read once (as JSON) to become directives to `SandboxManager.attach()`; nothing about them requires filesystem residency.

## Decision

Mounts and seed move to two new DB tables — `OrgWorktreeMountEntity` / `OrgWorktreeSeedEntity`, keyed `(org_id, repo_id, path)`, mirroring the existing `OrgWorktreeSecretGrantEntity` shape and ownership model exactly — read live by `WorktreeHydrator` at every hydration, through a new `WorktreeConfigStore`. There is no file in the live path at all: not committed, not generated-and-gitignored.

- **`write_worktree_config` becomes a pure DB write** keyed by `stimulus.orgId`/`stimulus.repoId` — no sandbox needed, no git operation. A mount is upserted by `path` (idempotent), seed paths are unioned (idempotent) — same merge semantics as before, now enforced by the store instead of a read-merge-write dance against a file.
- **Legacy migration is lazy, not a migration script.** Already-onboarded repos (e.g. cubix-infra) have a committed `atlas.json`. `WorktreeConfigStore.importLegacyIfEmpty(orgId, repoId, worktreePath)` — called once from `WorktreeProvisioner.provisionAndAttach()` — imports every entry from the legacy file IFF the DB currently has zero rows for that org+repo, after which the DB is authoritative. Table emptiness is the "already imported" flag; no extra column needed.
- **`finish_onboarding`'s ship condition changes from "wrote config" to "has an actual code diff."** Config/secrets are now live the instant they are written, so there is nothing about them left to ship. The onboarding ceremony still gates on `LocalGitService.hasChanges(worktreePath)` and ships a PR when true — onboarding threads have no other PR-opening tool, and a real code fix made along the way (a script bug, a `.gitignore` edit needed for a new secret/mount target) must still reach the repo.
- **The old 64KB/100-entry file caps are dropped** for the DB model (they existed to bound a committed file's diff size and defend against a hand-edited file); a `MAX_MOUNT_PATH_LEN` (512) ceiling is kept as an explicit check in `normalizeMounts`/`normalizeSeed`, since those tool-input validators are now the only guard this data gets.
- **`driver/worktree-manifest.ts` is deleted.** Its file-parsing logic (which still faces a real "attacker-editable git file" threat model, for the one remaining reader — the legacy importer) relocates to `onboarding/legacy-worktree-manifest.ts` as `loadLegacyManifestFile()`.

## Consequences

**Positive:** the exact lag the user hit is closed — a mount or seed path recorded by any thread is visible to every other in-flight job's very next turn, no PR, no wait, no rebase. `write_worktree_config` drops its `findSandbox` dependency and its file read-merge-write dance; the merge/upsert invariant is now enforced once, in the store, instead of duplicated by every caller. Onboarding's PR path is preserved for what actually still needs it: real repo edits.

**Negative / costs:** two more tables to migrate/manage (mirroring an existing pattern, so low marginal complexity). Mounts/seed are no longer visible in a `git diff` — an operator can no longer review a worktree-config change as part of code review; visibility is now the `appendSystemEvent` notice posted on every write, which is after-the-fact rather than gated. This mirrors how secrets already work and is accepted for the same reason (private, trusted deployment; transparency substitutes for a review gate).

## Alternatives considered

- **Keep `atlas.json` committed, auto-sync other in-flight branches on merge:** rejected. Still lags until merge, which is the actual complaint — a job that needs the mount *now* (mid-turn) can't wait for a PR cycle.
- **Keep `atlas.json` but generate it (gitignored) from the DB, for local inspectability:** rejected. No process reads it as a file once the DB is authoritative, so a generated copy is a synchronization liability (which one is truth if they briefly disagree?) for zero functional benefit.

## Status & rollout

Implemented: new entities + migration (`AddWorktreeMountsAndSeed`), `WorktreeConfigStore`, hydrator/provisioner/brain-tool call-site updates, `driver/worktree-manifest.ts` deleted. See `backend/src/app/onboarding/REDESIGN.md` for the updated propagation model.
