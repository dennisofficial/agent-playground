# ADR 0002 — Onboarding produces a hydration manifest + a process supervisor, not a stored boot recipe

- **Status:** Accepted — design; implementation not started.
- **Date:** 2026-07-01
- **Supersedes (in part):** the "secret-free onboarding thread" model in `atlas-repo-onboarding-thread` and the `.atlas/worktree.json` `{secrets, mounts, seed}` manifest in `backend/src/app/driver/worktree-manifest.ts`. The `secrets[]` archive field and `skipSecrets=true` onboarding-hydration branch are removed.

## Context

Onboarding a repo was modeled as a **secret-free reconnaissance thread** (`kind='onboarding'`): a brain-in-sandbox that explores the repo, reads `.env.example`, *registers* secret grants blind, and writes `.atlas/worktree.json` — but its sandbox is hydrated with `skipSecrets=true`, so it can never actually boot the environment it just configured. The operator watches Atlas configure a boot it has never performed, then admit it cannot validate. This is the wrong shape: **you cannot validate a boot you never ran.**

The product analogy is a new-hire Slack huddle: the engineer boots the dev environment live, hits "missing `DATABASE_URL`", is handed the key on the spot, and iterates until every service is actually up. The durable output is a *working, hydrated environment* — not a document.

Two temptations shaped the first cut of this redesign and were both rejected (see *Alternatives*):
1. A declarative **boot recipe** in the manifest (`boot.services[]` with `run` + `readyWhen` health checks + `dependsOn`) that a dedicated engine executes.
2. Per-thread **capability-credential gating** to limit blast radius of powerful creds (GCP, DB) in sandboxes.

## Decision

Onboarding becomes **"make the environment capable of running,"** and its durable artifact is a **hydration manifest** (`atlas.json`, renamed from `.atlas/worktree.json`) plus **evidence that the stack booted green**. It is *not* a stored, replayable boot script. Concretely:

### 1. `atlas.json` is a hydration manifest only

The manifest describes the **non-re-derivable** inputs a fresh worktree needs — never *how to run* the app (that is re-derivable by a coding agent from `package.json` / README / `CLAUDE.md`, and a stored copy only rots):

```jsonc
{
  "secrets": [ { "name": "BACKEND_ENV", "path": "backend/.env", "kind": "file" },
               { "name": "DATABASE_URL", "path": ".env", "kind": "value" } ],
  "mounts":  [ { "path": ".gcloud",        "mode": "shared-rw" },   // per-repo auth state
               { "path": ".pnpm-store",    "mode": "shared-ro" } ], // cache
  "seed":    [ "fixtures/golden.sqlite" ]
}
```

- **No `services` / `boot` / `readyWhen` section.** There is no stored boot recipe.
- **Secrets are file- *or* value-valued** (`kind`). A whole `.env` is a single file-valued secret — no more registering 20 keys one at a time.
- **`capabilities` is not a separate section.** A GCP service-account JSON is just a file-valued secret rendered to a gitignored path; the `gcloud auth activate-service-account` step is re-derived by the agent, not stored.

### 2. The process **supervisor** is the muscle; the agent + logs + repo docs are the recipe

Services never auto-start on sandbox attach. Bringing services up is done on demand through a managed long-running-process supervisor exposed to the brain as four tools:

- `run(cmd)` → start **detached** (survives the turn's `docker exec`), return a handle; writes a marker under the durable agent-home (`/workspace/.atlas/run/<id>.json`: pid, port, started-at).
- `logs(handle)` → captured stdout/stderr (streamable to the web UI; groundwork for future port-forwarding).
- `ps()` → running processes + status + port.
- `stop(handle)` → clean process-group kill.

`run` is **idempotent** (probe first; if already up, no-op). Health-checking is *not* declarative — the agent reads `logs`/curls the endpoint and decides "it's up," exactly as a human would. Boot know-how, if worth persisting for speed, is written as **prose in the repo's own `CLAUDE.md`/README** by onboarding — the single source of truth humans already maintain — not as structured config Atlas must keep in sync.

### 3. Blanket-render everything; the only guardrail is "don't commit it"

All secrets and capability creds render into **every** sandbox for the repo (no per-thread gating). This is deliberate: Atlas should be **at least as capable as local Claude Code**, which already runs with the user's full `gcloud`/`~/.aws`/SSH state and zero isolation. This is a private, trusted-friends deployment (see `saas-credential-compliance`); "tenant" means *private workspace*, not a hardened boundary. The one real hazard — a cred accidentally **committed** — is already covered by (a) hydration rendering only to **gitignored** paths and (b) the `commitAll` leak-scan. Killing `skipSecrets` is therefore free.

### 4. Stateful auth (gcloud/firebase/aws-sso) = a persistent per-repo `shared-rw` mount

Static secret *material* (a `.env`, an SA key) is injected fresh each hydration. **Auth state** — the mutating token dir produced by an interactive login — is different: it is persisted once and reused. It becomes a **per-repo, `shared-rw`** mount (host source survives sandbox reap; target path is whatever the repo's convention expects). Atlas authenticates **once**, headless (`gcloud auth login --no-browser` → URL surfaced on a card → operator pastes the code back); the token dir lands in the mount and every future sandbox reuses it (gcloud auto-refreshes). Two repos = two mount dirs = two simultaneous logins.

- This adds a **`shared-rw` mount mode**, which the current model forbids (`per-thread` | `shared-ro` only). The cross-sandbox token-refresh race is accepted: login is rare, refresh is near-atomic, worst case is "one job re-auths," not corruption.
- The base image gains **direnv** (hooked via `BASH_ENV`, same pattern as fnm). A repo that expresses its env via `.envrc` (e.g. `CLOUDSDK_CONFIG=./.gcloud`) is honored for free; Atlas `direnv allow`s the trusted worktree. Repos without `.envrc` get the mount at the tool's default path with the env exported by Atlas.

### 5. Two-speed propagation

- **Secret / mount grants** live in the org+repo-scoped store (DB) and propagate **instantly** to every job's next hydration — no merge.
- **`atlas.json`** is a committed file; changes ride the **job's own PR** and reach other jobs on merge. Reviewable and conflict-safe, at the cost of not being instant.

### 6. What flips `onboarded`, and drift

A repo is `onboarded` when the **ceremony brings the whole stack up green** via the supervisor and Atlas asserts it with **captured log evidence**, gated by the operator approving the onboarding PR (stamp `onboarded_at` then). External-mutating steps (`terraform apply`, real provisioning) are validated only to **plan/dry-run** — a sandbox never mutates real infra. Drift is **not** a diff against a stored recipe (there isn't one); it is detected by **re-running** — any job (or a re-onboarding) that finds the environment can't boot requests the missing secret/mount on the spot (instant grant) and/or amends `atlas.json` (rides its PR). Onboarding is one machinery with three triggers: **ceremony** (once), **amendment** (ongoing, per-delta), **re-validation** (idempotent re-run).

## Consequences

**Positive:** onboarding validates a boot it actually performed; every future job inherits a hydrated, runnable environment and can run real validation; the schema shrinks (no boot-recipe DSL, no `readyWhen`); no second source of truth for "how to run" to rot; the supervisor's captured logs unlock a live-processes UI and future port-forwarding; killing `skipSecrets` is free.

**Negative / costs:** onboarding sandboxes now hold real secrets while running repo code — accepted for a trusted deployment, and it makes the `commitAll` leak-scan load-bearing (must cover file-valued secrets + capability paths). The supervisor is net-new (nothing runs long-lived processes from the manifest today). The `shared-rw` mount mode reintroduces a small concurrency race the current model avoided. "Onboarded = green" rests on Atlas's assertion + log evidence + operator PR approval rather than a machine-checkable recipe.

## Alternatives considered

- **Declarative boot recipe (`boot.services[]` + `readyWhen` + a boot engine):** rejected. It duplicates knowledge already in `package.json`/README, and the stored copy silently *lies* when the repo changes a port or script — a drift-prone second source of truth. A smart agent re-derives the boot every time; the supervisor gives it robust long-running-process control without a DSL. `readyWhen` collapses into "agent reads logs."
- **Keep a thin `services` record (command + readyWhen) for reproducibility / non-LLM drift checks:** rejected. No stated need for non-LLM re-validation; re-onboarding is agent-driven anyway. The only truly non-re-derivable inputs are secrets/mounts, which the manifest already carries. Boot prose, if wanted, lives in `CLAUDE.md`.
- **Per-thread capability-credential gating (render powerful creds only into jobs that need them):** rejected as importing an untrusted-SaaS threat model. Local Claude Code already has broader, unisolated access; gating makes Atlas *less* capable for no real gain here and reintroduces the "I can't, I don't have access" friction the redesign exists to kill.
- **Auth state as an encrypted secret blob (re-injected each hydration):** rejected. Auth state *mutates* (token refresh); a value-oriented encrypted store fits static material, not a live-rewritten dir. A persistent mount is the right primitive.
- **Turn-scoped service lifecycle (tear down at end of turn):** rejected. It makes multi-turn validation (bring up in turn N, test in N+1) impossible — the point of a persistent container.

## Status & rollout

Design only; see `backend/src/app/onboarding/REDESIGN.md` for the full model and the seam map. Implementation to be planned next.
