# Atlas v2 — Tenant Onboarding Layer (multi-workspace SaaS)

## Context

A new Slack org should be able to install Atlas, add it to a channel, and self-provision everything Atlas needs to operate — LLM keys, coding-engine auth, and GitHub access — before any work happens. Today none of that exists: the symptom that started this (`[ChatStimulusBridge] inbound in unregistered channel C0B9L9BB891 … ignored`) is just the visible tip. Atlas v2 was deliberately rebuilt **single-tenant and env-driven** — every credential is one global env var, the Slack surface is one bot token over Socket Mode with no OAuth and no interactivity, and `atlas_teams` holds only `team_id/name/status`. There is no production path to register a channel, let alone onboard an org.

This plan re-introduces the **per-tenant credential + onboarding layer** that v1 had, rebuilt legibly into v2's clean spine. Decisions locked with the user:

- **Full multi-workspace SaaS now** — Slack OAuth install + per-workspace bot tokens + interactivity.
- **Secrets collected via Slack modals** (`view_submission`), never in chat text.
- **PAT-first for GitHub** (drops into the existing bearer/`GIT_CONFIG_*` seam); GitHub App is a later phase.
- **Triggers:** bot added to a channel (`member_joined_channel`) + `@mention` bootstrap + an Atlas brain capability to report/update config.
- **Authz:** anyone in the workspace.

The load-bearing design principle (mirrors v2's existing lazy-key + local/docker-sandbox philosophy): **every new resolution path falls back to the current env behavior when there is no tenant row, so single-tenant dev stays byte-identical and existing tests keep passing.**

---

## Architecture in one picture

```
Slack org installs ──OAuth──▶ atlas_slack_installations (per-workspace bot token, encrypted)
        │
   bot added to channel / @mention ──▶ OnboardingService (checklist + bindChannel)
        │                                      │
   interactive card ──▶ modal (view_submission)│──▶ TenantCredentialStore (encrypted: LLM key, engine auth, GitHub PAT)
        │                                      ▼
        └──────────────────────────▶ CredentialResolver.resolve(teamId)  ← env fallback
                                               │
        ┌──────────────────────────────────────┼───────────────────────────────┐
        ▼                                       ▼                               ▼
  brain/gate/planner LLM factories      engine-runner (args.auth)        repo-resolver / PR client (GitHub token)
```

One new `@Global` `OnboardingModule` owns the credential store + resolver + onboarding state machine. The Slack surface is refactored from a single client to a per-workspace registry with OAuth + interactivity. Everything else reads the resolver instead of env directly.

---

## Phase 0 — Credential foundation (build & prove first, in isolation)

Nothing downstream is safe until the resolver exists and is env-fallback-faithful.

**New files (`backend/src/atlas/onboarding/`):**
- `secret-cipher.ts` — pure AES-256-GCM helper keyed off `SECRETS_ENCRYPTION_KEY` (base64/hex → 32 bytes). Format `base64(iv).base64(tag).base64(ct)`. **Write refuses loudly without a key; reads/dev unaffected.** Key loaded lazily inside read/write, never at module construction. *This single cipher is reused by the Slack installation store in Phase 2.*
- `persistence/entities/atlas-tenant-credentials.entity.ts` — PK `(team_id, scope)`; `scope='*'` sentinel = team default (avoids NULL-in-unique-key breaking upsert; later resolves the dormant `atlas_projects.token_name` override). Columns: `anthropic_api_key_enc`, `openai_api_key_enc`, `github_pat_enc`, `engine_auth_mode` (default `'api_key'`), `engine_auth_secret_enc` (all secrets store ciphertext). FK `team_id → atlas_teams ON DELETE CASCADE`.
- `tenant-credential.store.ts` — `read(teamId, scope='*')` → decrypted `TenantCredentials | null`; `write(teamId, patch, scope)` (only provided fields encrypted+written); `presence(teamId, scope)` → boolean flags **without decrypting** (for the checklist). Never logs secret values.
- `credential-resolver.service.ts` — the seam. `anthropicKey(teamId?)`, `openaiKey(teamId?)`, `engineAuth(teamId?, engine)`, `githubToken(teamId?)`. **Env-fallback contract (must be byte-identical):** `teamId` undefined / no row / null column returns exactly what today's code returns:
    - `anthropicKey` → `env.get('ANTHROPIC_API_KEY')`
    - `openaiKey` → `env.get('OPENAI_API_KEY')`
    - `githubToken` → `env.get('ATLAS_GITHUB_TOKEN') ?? env.get('GITHUB_TOKEN')`
    - `engineAuth` → reproduce `engine-runner.service.ts:101-113` exactly (incl. the subscription→api_key warn-fallback). **Extract that env branch into a shared helper both `resolveAuth` and the resolver call** — do not reimplement.
- `onboarding.module.ts` — `@Global`; provides/exports `TenantCredentialStore`, `CredentialResolver` (and `OnboardingService` in P1). Imported **early** in `app.module.ts` so brain/driver factories can inject it.

**Refactor consumers to read the resolver (env-fallback preserves behavior):**
- The 4 LLM/embedding factories — `brain/brain.module.ts:78`, `decision-gate/decision-gate.module.ts:28`, `driver/driver.module.ts:66`, `memory/` embedding. Each already caches clients in a `Map<string, Client>` keyed by key-string, so per-team is nearly free. Recommended low-churn shape: change the injected key thunk from sync `() => env.get(...)` to async `(teamId?) => resolver.anthropicKey(teamId)`; resolve the key **once at the top** of each adapter public method (`triage`/`grill`/`classify`/`planSection`/`embed`) — add an optional trailing `teamId?` param (callers with it — `stimulus.teamId`/`job.teamId` — pass it; others omit → env fallback). Keep the cache lookup synchronous below.
- Engine auth — **no `EngineRunner` change needed**: `RunEngineArgs.auth` already wins over env (`engine-runner.service.ts:100`). `SectionDriver` resolves `engineAuth(job.teamId,'claude')` once per job and passes `auth` into every `runTurnBounded` call (today it leaves it undefined). Same for `scoping-investigator` (`engine.run`) and `acceptance-gate` (passes `undefined` → env, it's a self-test).
- GitHub token — replace the inline `env.get('ATLAS_GITHUB_TOKEN') ?? env.get('GITHUB_TOKEN')` at `driver/repo-resolver.ts:76`, `brain/scoping-investigator.ts`, `gate/acceptance-gate.service.ts:63` with `await resolver.githubToken(teamId)`.

**Gate:** full existing atlas suite passes with **zero tenant rows** (proves byte-identical single-tenant). Do not proceed until green.

---

## Phase 1 — Onboarding service + channel binding (fixes the original symptom)

- `onboarding/onboarding.service.ts`:
    - `bindChannel({teamId, projectId, repoUrl?, baseBranch?, channelRef, displayName?})` — **promote** the upsert logic from `test-bridge.controller.ts:99-138` (team + project + the channel find-or-create over unique `(team_id, project_id)`). **This is the fix for "unregistered channel ignored"** — the chat bridge keys on `(team_id, surface_channel_ref)`. Change vs the seed code: fresh teams start `status:'onboarding'`; **preserve existing status on re-bind** (don't reset `active`→`onboarding` on a repo re-point).
    - `status(teamId)` / `nextStep(teamId)` — checklist **derived, no new table**: installed (`atlas_teams` exists) · channelBound (`surface_channel_ref` + `git_url` set) · llmKey/githubPat/engineAuth (`store.presence()`) · validated (transient) · active (`status==='active'`). Only genuinely new state is the lifecycle value, which already lives in `atlas_teams.status` (`pending → onboarding → active`).
    - `validateRepo(teamId, projectId)` — `GithubPrService.getRepo(token, owner, repo)` probe (null = unreachable/bad PAT). `validateLlmKey(teamId)` — one cheap bounded call (401 surfaces a bad key early). `tryActivate(teamId)` — all steps pass → `status='active'`.
- Refactor `/test/seed` to **delegate to `bindChannel`** (one implementation, not two). Gate: test-bridge e2e still seeds/routes.

---

## Phase 2 — Slack multi-workspace transport (the heaviest piece)

Verified SDK facts (from `node_modules`): `SocketModeClient` emits `slack_event` for **every** envelope type (`events_api | interactive | slash_commands`) and `ack(response)` forwards a payload (for `view_submission` response-actions); `WebClient.oauth.v2.access` exists; `@slack/oauth`/`@slack/bolt` are **not** deps; `SLACK_CLIENT_ID/SECRET/SIGNING_SECRET` already declared (optional) in v1 validation.

- **Transport model:** keep **one app-level (`xapp-`) Socket Mode connection** for all inbound (events + interactivity + modals) across every workspace — each envelope carries `team_id`. Store per-workspace `xoxb-` bot tokens (from OAuth) for posting only. Wrap behind a `SlackTransport` seam so an HTTP-Events adapter can drop in later. *(Pre-flight: a 2-workspace install spike to confirm one socket fans in both teams' events + button clicks with distinct `team_id`.)*
- **OAuth (hand-rolled, no new dep):** `surface/slack-oauth.controller.ts` mounted like `ingress/*.controller.ts` on the existing port-4002 HTTP app — `GET /slack/install` (302 to `oauth/v2/authorize` + signed `state`), `GET /slack/oauth_redirect` (verify state → `new WebClient().oauth.v2.access({client_id, client_secret, code, redirect_uri})` → persist install → upsert `atlas_teams`).
- **Installation store:** `persistence/entities/atlas-slack-installations.entity.ts` (PK `team_id`; `bot_token` encrypted via a TypeORM `ValueTransformer` over `secret-cipher.ts`; `bot_user_id`, `scopes`, `team_name`, `installed_at`). `surface/slack-installation.store.ts` with in-memory cache: `botToken(teamId)`, `botUserId(teamId)`.
- **Per-workspace posting + port change:** `AtlasSlackSurface` gets a `WebClient` **registry keyed by team_id**, lazily built from the store, **falling back to the env client** when no install row exists (preserves single-token dev). Thread `teamId` via **optional `PostOptions.teamId`** (purely additive — every outbound caller already has `teamId` in scope; a post with no resolvable team and no fallback is dropped+logged, never mis-routed). `ChatStimulus.replyRoute` gains `teamId` (jsonb column → no migration). Blast radius = ~7 structs, each fed from a `teamId` already present: `decision-approval` (`ApprovalTarget`), `conversational-brain`, `section-driver` (`JobRoute`/`ThreadRoute`, `job.teamId`), `surface-orchestration`, `park-and-ask` (`ParkTarget`), `plan-visibility` (`SectionPlanPost`), `acceptance-gate` (`GateConfig` → fallback). Re-grep `surface.post(` after editing.
- **Interactivity (wires the currently-dropped buttons):** extend `handleEnvelope` to handle `envelope.type === 'interactive'`. Expose `interactive$` / `viewSubmission$` Subjects on the surface (mirrors `inbound$`, like `park-and-ask` subscribes) to avoid a circular dep with `DecisionApprovalService`. A thin approval bridge subscribes and routes `block_actions` by `action_id` prefix: `atlas_approval:*` (already defined in `approval-blocks.ts:9-12`) → `DecisionApprovalService.resolve(jobId, verdict, payload.user.id)` then `chat.update` the card; `atlas_onboarding:*` → `views.open({trigger_id, view})`. `view_submission` routed by `view.callback_id` prefix `atlas_secret:*` → encrypt+store → ack `{}` (or `{response_action:'errors'}`). The existing `/test/approve` HTTP path stays working (two verdict sources, one `resolve`). Add `views.open` + `chat.update` to the structural `SlackWebClientLike` so specs stay fakeable.
- **Lifecycle + per-team echo guard:** add a `lifecycle$` Subject. In the events_api branch, before the message-only `emitInbound`, detect `member_joined_channel`/`member_left_channel` where `event.user === botUserId(team_id)` → emit `bot_joined`/`bot_left`; optional `app_mention` → `mention` for bootstrap (these never enter `StimulusIntake`). Echo guard changes `event.user === this.selfUserId` → `event.user === botUserId(teamId)` (cache lookup, env `selfUserId` fallback in single-token dev).

---

## Phase 3 — Onboarding surfaces (cards, modal, Atlas capability)

- **The onboarding flow:** `OnboardingService`/a card builder subscribes to `lifecycle$` (`bot_joined`) → posts a "Set up Atlas" interactive card in the channel (`atlas_onboarding:*` buttons). Buttons open Block Kit modals (`views.open` via `trigger_id`) collecting: repo URL/branch (non-secret), then secrets (Anthropic key, GitHub PAT) in `plain_text_input` fields. `view_submission` (`callback_id: atlas_secret:*`) → `TenantCredentialStore.write(teamId, patch)` → `OnboardingService.tryActivate(teamId)`. **The modal is the only secret-write path; `CredentialResolver`/`TenantCredentialStore` the only decrypt path.**
- **Atlas brain capability** (`onboarding/onboarding-brain.service.ts`) — injectable service called by brain logic, **not** an engine tool (do not touch `engine-core.ts`'s fixed toolset). `reportStatus` (checklist in-thread), `updateConfig` (non-secret only: repo/branch/engine mode), `requestSecretCollection` (emits the **intent** to open a modal — never parses secrets from chat; refuses + redirects if a user pastes a key). Hook in `triage.service.ts` `triageChat` (recommend adding an `'onboard'` verb to the brain triage enum + one branch) and as a collaborator in `conversational-brain.service.ts`.

---

## Phase 4 — Migration, wiring, hardening

- `persistence/entities/index.ts`: export + add `AtlasTenantCredentials` and `AtlasSlackInstallations` to `ATLAS_ENTITIES`.
- Migration: `pnpm -C backend db:atlas:migration:generate AddOnboardingTables` → prune generator noise → `pnpm -C backend db:atlas:migrate`. Verify PKs/FKs follow the `pk_/fk_/idx_` naming strategy; `atlas_teams.status` needs **no** migration (free-form text, default unchanged).
- `app/app.module.ts`: import `OnboardingModule` (early, before BrainModule/DriverModule).
- Hardening: `tokens_revoked`/`app_uninstalled` → soft-delete the installation; socket reconnect health.

---

## Env / Slack-app prerequisites (SaaS distribution)

- Env: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, an OAuth redirect/public host, and **`SECRETS_ENCRYPTION_KEY` (required in prod — onboarding secret writes refuse without it)**. Existing `ATLAS_SLACK_APP_TOKEN` (app-level) stays for the socket.
- Slack app config (api.slack.com): enable distribution + redirect URL; bot scopes (chat:write, channels:read, groups:read, channels:history, reactions:write, commands if used); Socket Mode on; Interactivity on; Event subscriptions incl. `member_joined_channel`, `member_left_channel`, `app_mention`, `message.channels`.

---

## Riskiest assumptions (verify before/at build)

1. **Distributed Socket Mode** — one app-level socket fans in all workspaces' events + interactivity with distinct `team_id` (P2 pre-flight spike; everything rests on this).
2. **Env-fallback byte-identity** — `engineAuth(undefined)` must reproduce the existing subscription→api_key warn-fallback exactly (shared helper, not reimplemented).
3. **Async-`client()` ripple** in LLM adapters — resolve key once at top of each public method; confirm no synchronous callers.
4. **`view_submission` ack-with-response over Socket Mode `ack(response)`** behaves like Bolt's HTTP path (validate with a real modal).
5. **`oauth.v2.access` field names** (`access_token`, `bot_user_id`, `team.id`, `scope`) — confirm against a live exchange.
6. **Port blast radius** = exactly the ~7 structs in P2 — re-grep `surface.post(` after editing.
7. **`scope='*'` vs `token_name`** override convention — pick now (dormant today) to avoid a later migration.

---

## Verification

- **Per phase, unit/spec:** P0 — resolver env-fallback contract (no tenant row + `ANTHROPIC_API_KEY` set → client uses env key); cipher round-trip + refuse-without-key. P1 — `bindChannel` upsert/conflict/status-preservation; derived `status`. P2 — surface specs with fake `SlackWebClientLike` (registry fallback, `PostOptions.teamId` routing, interactive dispatch, lifecycle emission, per-team echo guard). Run `pnpm -C backend test` (atlas unit) green throughout.
- **Integration:** `*.int.test.ts` against `agent_playground_test` for the new entities/stores (`docker compose up -d postgres`).
- **End-to-end (the original symptom):** with the test-bridge or a real install, bind channel `C0B9L9BB891` to its repo via `OnboardingService.bindChannel`, send a message, confirm it is no longer "ignored" and Atlas responds.
- **Live multi-workspace (manual, user-run):** install into a 2nd workspace via `/slack/install`; confirm OAuth stores the per-workspace token; bot-added card appears; modal collects + encrypts a key; an approval-card button now resolves a real job; Atlas posts back using the correct per-workspace token. (Per house rule, Dennis runs subjective/live feel checks — no self-billed runs.)
- **Security check:** grep the new code paths to confirm no secret is logged and the only decrypt path is the resolver/store.