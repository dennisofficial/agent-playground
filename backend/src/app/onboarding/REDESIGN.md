# Onboarding redesign — the repo's living, self-healing environment

> Design doc for the ADR-0002 reframe. Read `docs/adr/0002-onboarding-hydration-manifest-not-boot-recipe.md` first for the decision + rejected alternatives; this doc holds the full model, the vocabulary, and the seam map for the implementation plan.
>
> **Terminology note:** this doc predates the "Workspace Profile" rename. Read "worktree config" as **workspace config** and `WorktreeConfigStore`/`WorktreeSecretFileStore`/`org_worktree_*` as `WorkspaceConfigStore`/`WorkspaceSecretFileStore`/`org_workspace_*` (tool `write_worktree_config` → `write_workspace_config`). See `backend/src/app/ARCHITECTURE.md` "The Workspace Profile" for the current vocabulary.

## The reframe in one line

Onboarding stops being a *secret-free reconnaissance thread* and becomes **the process of making a repo's environment capable of running — proven by actually running it — with the non-re-derivable inputs (secrets, auth state, caches) captured so every future job inherits a hydrated, runnable box.**

The test of "onboarded" is not a document; it's: **a fresh worktree + current grants + mounts = a stack Atlas can bring up green, reproducibly.**

## Vocabulary

- **Onboarding ceremony** — the first, long, thorough pass where Atlas stands up the whole repo headlessly, discovering the secrets/auth/mounts it needs *live* (asking on the spot), until the stack comes up green. Happens once per repo. The ceremony also makes every **user-facing surface** browser-accessible through the preview proxy — exposing it (`atlas-svc run` + Caddy), remediating the accessibility blockers env-first, and proving it as a browser with `atlas-probe` — so a live test just works and the resolved config persists into the profile for every future job. See `docs/adr/0007-live-service-accessibility-onboarding.md`.
- **Amendment** — the same machinery on a delta, from ANY thread, not just onboarding. The ceremony and an ordinary build thread have the **identical toolset** (`request_secret`/`request_file`/`derive_secret`/`write_worktree_config`) — the ceremony just uses it exhaustively, up front, in one pass; a build thread uses it incrementally, whenever it hits the same kind of friction. `write_worktree_config` **merges** onto whatever's already recorded in the DB (upserts a mount by path) rather than overwriting, so a thread amending config for ONE new mount can never clobber what the ceremony (or an earlier amendment) already recorded — see `docs/adr/0003-worktree-config-db-not-git.md`. `finish_onboarding` is the one ceremony-only tool (stamps `onboarded_at`, and ships a PR only if it made an actual repo code edit along the way — config itself is never what's shipped, it's already live).
- **Re-validation** — an idempotent re-run of the ceremony; the way drift is detected (by *trying to run*, not by diffing a stored recipe).
- **Worktree config** — org+repo-scoped DB rows (`OrgWorktreeMountEntity`) declaring `mounts` — the non-re-derivable, non-secret hydration inputs. (A former `seed` mechanism — golden files copied from a host `ATLAS_GOLDEN_ROOT` — was removed as a half-built dead end; commit non-secret defaults or use request_secret/request_file instead.) **Never** how to run the app. (Was `atlas.json`, a committed file, renamed from `.atlas/worktree.json`; moved off git entirely by ADR-0003. A legacy `atlas.json` still already-onboarded in a repo is imported once, lazily, on first attach.)
- **Secret** — an encrypted thing that lands at a **gitignored** path. `kind: "value"` (a scalar env var) or `kind: "file"` (a whole `.env`, an SA-key JSON). "Capability creds" (gcloud/Firebase/DB) are *just* file-valued secrets — no separate category.
- **Derived secret** — a value Atlas *computed itself* (not operator-provided) from a credential it already holds — e.g. a Stripe webhook signing secret from `stripe listen --print-secret`, derived from the granted `STRIPE_API_KEY`. `derive_secret({ name, path, value, description, overwrite? })` writes it straight to the same encrypted store + grant as `request_secret`, with **no operator round-trip** (there's nothing for an operator to gate — Atlas already legitimately held the input). Refuses by default if `name` already has a value (protects an operator-provided secret from being silently clobbered); `overwrite: true` opts in explicitly. Posts a quiet `appendSystemEvent` notice for visibility (name/path only, never the value).
- **Auth state** — the *mutating* token dir produced by an interactive login (`gcloud auth login` → `CLOUDSDK_CONFIG`). Not a secret you inject; a **persistent per-repo `shared-rw` mount** you set up once and reuse.
- **Supervisor** — the managed long-running-process layer (`run`/`logs`/`ps`/`stop`) that brings services up **on demand** (never on attach). The agent + its logs are the health check; the repo's own docs are the recipe.
- **Grant** — the org+repo-scoped store record binding a secret/mount to a destination path. Propagates **instantly** (DB) — see `docs/adr/0003-worktree-config-db-not-git.md`.

## Propagation — everything is instant now

Secrets and worktree config (mounts) are BOTH org+repo-scoped DB rows now — `write_worktree_config`'s mounts and `request_secret`/`derive_secret`'s grants all land the same way: written straight to the DB, read live by `WorktreeHydrator` on the next hydration of ANY job on the repo. No file, no PR, no merge, no rebase-and-hope. (ADR-0002 originally split this into two speeds — instant grants vs. a committed `atlas.json` riding a PR — but the file-based half caused the exact lag it now avoids: a job would add a mount and other in-flight jobs would never see it before their branch happened to rebase past the merge. ADR-0003 killed the file entirely.) The only thing that still rides a PR is an actual repo code edit made along the way (a script fix, a `.gitignore` change) — `finish_onboarding` ships that, gated on `LocalGitService.hasChanges()`, not on whether config was written.

## Three things enter a sandbox

1. **Secrets** (file/value) — static, re-rendered fresh each hydration to gitignored paths. Blanket-rendered into every sandbox (parity with local Claude Code).
2. **Auth state** (`.gcloud`, firebase, aws-sso) — persistent per-repo `shared-rw` mount; set up once via the headless-login card; honored via **direnv** if the repo uses `.envrc`, else mounted at the tool's default path with env exported by Atlas.
3. **Caches** (pnpm store, next cache) — existing mounts.

## Sharp edges, resolved (from the grill)

- **Service lifecycle across turns** — container-lifetime, detached, tracked by supervisor markers on the durable agent-home; `run` idempotent (probe-first); container reap is the backstop.
- **Idle-reap** — markers survive the reap; on restart the supervisor reports previously-running-now-dead services in the restart notice Atlas already gets; Atlas restarts on demand (no auto-start).
- **`skipSecrets` kill** — onboarding sandboxes now hold real secrets; the `commitAll` leak-scan becomes load-bearing and must cover file-valued secrets + capability paths (all gitignored).
- **Capability blast radius** — non-issue for this trusted deployment; blanket-render.
- **External side effects** — `terraform apply` etc. validated to **plan/dry-run** only; a sandbox never mutates real infra.
- **`onboarded_at`** — stamped when the ceremony brings the stack up green (supervisor + captured log evidence) and the operator approves the onboarding PR.
- **Prove-it-cold-boots (`reset_sandbox`)** — "runs right now" isn't "runs on a fresh box." Any brain thread (shared via the `intake` toolset) can call `reset_sandbox({ reason })` to recreate its container from scratch. It's a TARGETED reset, not a wipe: the worktree, recorded mounts, granted secrets, and the durable `/.atlas` (transcripts + atlas-svc supervisor state) survive; container-filesystem-outside-binds, running processes, DinD, and shell env do not — so whatever Atlas has to redo by hand is exactly the ephemeral state it forgot to record (a login dir not captured as a `shared-rw` mount, a global install outside `/workspace`). Turn-boundary by construction (a mid-turn teardown would kill the exec running the call): the tool only FLAGS a reset + tells Atlas to stop; the turn tail (`maybeHonorSandboxReset`) tears down and kicks a synthetic verify continuation. The verify instruction rides the existing `SANDBOX_RESET_NOTICE` on the first cold-attached turn (operator or synthetic) so a queued operator message can't steal it; a soft loop guard caps consecutive unattended resets. Guidance only — not a hard `finish_onboarding` gate.

## Seam map (current code → what changes)

| Area | Current | Change |
|---|---|---|
| Manifest | `onboarding/worktree-config.store.ts` `{mounts}` (DB-backed, org+repo scoped) | superseded the committed `atlas.json` file (ADR-0003); `onboarding/legacy-worktree-manifest.ts` imports a pre-existing file's mounts once, lazily, on first attach (a legacy `seed[]` is ignored) |
| Onboarding thread | `onboarding/onboarding.service.ts` `maybeStartRepoOnboarding`/`reonboardRepo`; prompt `brain/agent-session-manager.service.ts:541-591` | prompt rewrites to boot-and-validate loop; `finish_onboarding` requires green + evidence before `onboarded_at` |
| Hydration | `driver/worktree-provisioner.service.ts` (+`worktree-hydrator.service.ts`) `skipSecrets=true` for onboarding | remove `skipSecrets`; add live mid-session re-hydrate trigger on new grant; render file-valued secrets |
| Secret intake | `web-surface.controller.ts` `POST …/provide-secret`; brain `request_secret` (onboarding-only) | widen `request_secret` to any job; add file-valued path (lean on existing `request_file`); add headless-login card for auth state |
| Grants | `onboarding/worktree-secret.store.ts` + `org-worktree-secret*.entity.ts` | file-valued secret storage; persistent per-repo auth-state mount records |
| Sandbox | `sandbox/sandbox-manager.service.ts` mounts; base image (fnm via `BASH_ENV`) | add `shared-rw` per-repo mount; add **direnv** to base image + shell init |
| Supervisor | — (nothing runs long-lived processes from the manifest) | **net-new**: `run`/`logs`/`ps`/`stop` tools + marker registry on agent-home + web log surface |

## Status

All of the above is built and live-validated (a real onboarding ceremony on a real multi-service repo, plus a *second* job in the same repo inheriting the hydrated environment with zero secret hand-off): the supervisor (`atlas-svc run/logs/ps/stop`, detached + marker-tracked on the durable agent-home), the headless-login card (`url` on `WebSecretInputCard`, reusing the secret-card mechanism), `finish_onboarding`'s green-gate (`verified` evidence required before it stamps `onboarded_at`), and (ADR-0003) moving mounts off the committed `atlas.json` entirely onto DB-backed worktree config with a lazy legacy-file importer.

Since then (ADR-0007), the ceremony additionally proves **live browser accessibility** of each user-facing surface through the preview proxy — `atlas-probe` (baked Playwright + chromium) loads the public preview URL headless, classifies any blocker (dns / bind_ip / port / dev_origin / cors / api_base_url / cookie / blank), and the brain remediates env-first (minimal PR only when repo code must READ that env) and persists the resolved config. `finish_onboarding`'s green-gate now requires that live preview-accessibility evidence in its `verified` set, so "onboarded" means the stack loads and hydrates in a browser, not just that a port is listening.
