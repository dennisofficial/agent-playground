# Onboarding redesign — the repo's living, self-healing environment

> Design doc for the ADR-0002 reframe. Read `docs/adr/0002-onboarding-hydration-manifest-not-boot-recipe.md` first for the decision + rejected alternatives; this doc holds the full model, the vocabulary, and the seam map for the implementation plan.

## The reframe in one line

Onboarding stops being a *secret-free reconnaissance thread* and becomes **the process of making a repo's environment capable of running — proven by actually running it — with the non-re-derivable inputs (secrets, auth state, caches) captured so every future job inherits a hydrated, runnable box.**

The test of "onboarded" is not a document; it's: **a fresh worktree + current grants + mounts = a stack Atlas can bring up green, reproducibly.**

## Vocabulary

- **Onboarding ceremony** — the first, long, thorough pass where Atlas stands up the whole repo headlessly, discovering the secrets/auth/mounts it needs *live* (asking on the spot), until the stack comes up green. Happens once per repo.
- **Amendment** — the same machinery on a delta: any job that finds the env can't do something (missing key, new service) requests it on the spot and/or amends `atlas.json`. Every future job inherits it.
- **Re-validation** — an idempotent re-run of the ceremony; the way drift is detected (by *trying to run*, not by diffing a stored recipe).
- **Hydration manifest** — `atlas.json` (renamed from `.atlas/worktree.json`). Declares `secrets`, `mounts`, `seed`. The non-re-derivable inputs only. **Never** how to run the app.
- **Secret** — an encrypted thing that lands at a **gitignored** path. `kind: "value"` (a scalar env var) or `kind: "file"` (a whole `.env`, an SA-key JSON). "Capability creds" (gcloud/Firebase/DB) are *just* file-valued secrets — no separate category.
- **Auth state** — the *mutating* token dir produced by an interactive login (`gcloud auth login` → `CLOUDSDK_CONFIG`). Not a secret you inject; a **persistent per-repo `shared-rw` mount** you set up once and reuse.
- **Supervisor** — the managed long-running-process layer (`run`/`logs`/`ps`/`stop`) that brings services up **on demand** (never on attach). The agent + its logs are the health check; the repo's own docs are the recipe.
- **Grant** — the org+repo-scoped store record binding a secret/mount to a destination path. Propagates **instantly** (DB). Distinct from `atlas.json` config, which rides a **PR**.

## The two-speed propagation model

| What | Home | Propagation | Landing |
|---|---|---|---|
| Secret values, auth-state mounts | encrypted grants (org+repo DB) | **instant** — next hydration of any job | direct, no review |
| `atlas.json` (secret name→path, mounts, seed) | committed file | on **PR merge** | rides the job's own PR |

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

## Seam map (current code → what changes)

| Area | Current | Change |
|---|---|---|
| Manifest | `driver/worktree-manifest.ts` `{secrets(dead), mounts, seed}` | rename `.atlas/worktree.json`→`atlas.json`; drop dead `secrets[]` archive; `secrets` gains `kind: value\|file`; `MountMode` gains `shared-rw` |
| Onboarding thread | `onboarding/onboarding.service.ts` `maybeStartRepoOnboarding`/`reonboardRepo`; prompt `brain/agent-session-manager.service.ts:541-591` | prompt rewrites to boot-and-validate loop; `finish_onboarding` requires green + evidence before `onboarded_at` |
| Hydration | `driver/worktree-provisioner.service.ts` (+`worktree-hydrator.service.ts`) `skipSecrets=true` for onboarding | remove `skipSecrets`; add live mid-session re-hydrate trigger on new grant; render file-valued secrets |
| Secret intake | `web-surface.controller.ts` `POST …/provide-secret`; brain `request_secret` (onboarding-only) | widen `request_secret` to any job; add file-valued path (lean on existing `request_file`); add headless-login card for auth state |
| Grants | `onboarding/worktree-secret.store.ts` + `org-worktree-secret*.entity.ts` | file-valued secret storage; persistent per-repo auth-state mount records |
| Sandbox | `sandbox/sandbox-manager.service.ts` mounts; base image (fnm via `BASH_ENV`) | add `shared-rw` per-repo mount; add **direnv** to base image + shell init |
| Supervisor | — (nothing runs long-lived processes from the manifest) | **net-new**: `run`/`logs`/`ps`/`stop` tools + marker registry on agent-home + web log surface |

## Open for the implementation plan

- Exact supervisor process model (detach mechanism, marker schema, log capture path, web streaming seam).
- The headless-login card flow (URL out, code back) reusing the secret-card mechanism.
- Migration: `.atlas/worktree.json` → `atlas.json`, and the manifest schema change.
- `finish_onboarding` green-gate + evidence capture.
