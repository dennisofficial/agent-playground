# Slack apps setup (single-process multi-tenant)

The harness uses a **two-tier** Slack app topology. After the single-process refactor, all tokens
are stored per workspace (`team_id`) in the DB, so each app is created ONCE and installed into every
workspace via **unlisted distribution**.

## App inventory

| App | Count | Transport | Job |
|---|---|---|---|
| **AI Crew (Dev)** | 1 | **Socket Mode ONLY** | Local-dev ears (event listener). Local quick-edit/test only. |
| **AI Crew** (prod) | 1 | **Events API / HTTP ONLY** | Deployed-prod ears: the one event listener + fallback poster. |
| **Puppet: Alex/Maya/Nora/James/Sam/Riley** | 6 | HTTP, no events | Each posts + reacts as that employee (real bot user, name + avatar). **Sam is the team lead** — his puppet is effectively required per workspace (lead presence, below). |

- **Ears = two separate apps** (dev Socket Mode, prod Events API) — same code, different credentials.
  `main.ts` branches on `SLACK_APP_TOKEN`: set → Socket Mode (dev); unset → Events API (prod).
  **Both are OAuth-distributed**: the per-workspace bot token comes from the install (stored
  encrypted in the `tenants` row); the harness resolves the right workspace's ears client per
  `team_id` (`TenantSlackClients`). Dev's Socket-Mode app also has a `SLACK_BOT_TOKEN` env that
  serves as the single-workspace fallback.
- **Puppets are global** (one app per employee), distributed *unlisted*, installed into each
  workspace. Bot ids: `alex`, `maya`, `nora`, `james`, `sam`, `riley`. **Puppets need NO
  Socket-Mode variant — ever** (dev or prod): they only POST/REACT over HTTP and never receive
  events. One puppet app per employee covers both; in dev you just install it into your dev
  workspace and store its token under that workspace's `team_id`.
- **Puppets are optional.** With no puppet token for an employee, the ears app posts on their behalf
  with a `username`/`icon_url` override (reactions then show as the ears app — that's the one thing
  puppets fix).

---

## Manifests

The manifest files live in **`backend/slack-manifests/`** — paste one into api.slack.com/apps →
"From a manifest" (they're the source of truth; don't restate YAML here):

| File | App |
|---|---|
| `ears.prod.yaml` | `AI Crew` — prod ears (Events API; request URLs point at `https://YOUR_HOST`) |
| `ears.dev.yaml` | `AI Crew (Dev)` — dev ears (Socket Mode; no request URLs) |
| `puppet.alex.yaml` … `puppet.riley.yaml` | the 6 employee puppets (`alex`, `riley`, `maya`, `james`, `nora`, `sam`) |

Notes:
- **Replace `https://YOUR_HOST`** with the deployed base URL before creating each app.
- Both ears apps carry `channels:manage` + `groups:write` (team-lead presence invites). If an ears
  app predates those scopes, update it from the manifest and REINSTALL it per workspace.
- The dev ears app additionally needs a manually-minted **app-level token** (`connections:write`) —
  that's the `xapp-…` for `SLACK_APP_TOKEN`; manifests can't declare it.
- Puppets never listen (no event subscriptions, no interactivity). Their redirect URL is the
  one-click capture path `/slack/puppet/oauth` (bot id rides in the install link's `state`).
- Set each puppet's **app icon** to that employee's avatar (`web/public/avatars/<style>/<botId>.png`)
  so posts/reactions carry the face.

---

## Setup steps

1. **Create the apps** (api.slack.com/apps → "From a manifest"): the prod ears, the dev ears, and the
   6 puppets, using the files in `backend/slack-manifests/`.
2. **Unlisted distribution** for the prod ears + 6 puppets: each app → *Manage Distribution* →
   complete the checklist → "Activate Public Distribution". Keep them unlisted (don't submit to the
   Marketplace); you just share the install link privately.
3. **Set deploy env** (the prod ears app):
   - `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (for OAuth install + signature verification)
   - `GATEWAY_PUBLIC_URL=https://YOUR_HOST` (the OAuth redirect base)
   - `SECRETS_ENCRYPTION_KEY`, `ADMIN_API_TOKEN`, `PORT`
   - LEAVE `SLACK_APP_TOKEN` UNSET → Events API mode.
4. **Install the ears into each workspace** via its OAuth link → the `/slack/oauth` callback stores
   that workspace's bot token in the `tenants` row (encrypted). The process starts serving that
   `team_id` immediately; invite it to channels and Jarvis takes over onboarding.
5. **Install each puppet into each workspace.** Two ways to capture the per-workspace token:
   - **One-click (recommended):** configure `SLACK_PUPPET_OAUTH` (JSON map of bot id →
     `{clientId, clientSecret}`), set each puppet's redirect URL to
     `https://YOUR_HOST/slack/puppet/oauth`, and put the bot id in the install link's `state`
     (e.g. `…&state=alex`). The `/slack/puppet/oauth` callback exchanges the code and stores the
     token in `slack_identities` under `(team_id, alex)` automatically.
   - **Manual:** grab the token from the puppet app's *OAuth & Permissions* page (your own
     workspace) or do the `oauth.v2.access` exchange yourself, then:
     ```
     PUT https://YOUR_HOST/tenants/<team_id>/slack-identities/alex
     Authorization: Bearer <ADMIN_API_TOKEN>
     { "token": "xoxb-<the puppet's bot token for THIS workspace>" }
     ```
   Either way, `SlackIdentityRegistry` picks it up within ~60s. Repeat for the 6 bot ids × workspace.

### Local dev
Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (the dev ears app) and run `pnpm slack:dev`. Messages from
your dev workspace carry its real `team_id`; LLM keys fall back to `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
env, so you don't need the keys modal locally. Puppets are optional in dev — add their tokens under
the dev workspace's `team_id` the same way if you want real per-employee identity.

Puppet identities survive a DB recreate via the seed: put the tokens in `.env.personal` as
`SLACK_PUPPET_SEED={"teamId":"T0…","tokens":{"alex":"xoxb-…", …}}` and `pnpm db:recreate`
(drop → migrate → seed) restores `slack_identities` automatically — each token is re-verified via
`auth.test`, so user ids stay correct. `pnpm puppet:register` remains the one-off manual path.

---

## Team Lead presence

The team lead's (Sam's) puppet is kept in **every group chat** the harness serves — DMs are exempt.
Enforcement is an attempt-based ladder in `LeadPresenceService` (hooked from the inbound router on
every event, fire-and-forget):

1. **Public channels** — Sam's puppet joins itself (`conversations.join`; the puppet manifest's
   `channels:join` already covers it).
2. **Private channels** (or a failed join) — the EARS app, which is necessarily a member (it
   received the event), invites Sam (`conversations.invite`; needs the ears scopes `groups:write`
   + `channels:manage` above).
3. **Neither possible** (no Sam puppet token for the workspace, missing scopes) — ONE deterministic
   nag per channel, posted as Jarvis, asking to `/invite @Sam`. Manual `/invite` clears the state
   via `member_joined_channel`.

> **Adding the new ears scopes requires REINSTALLING the ears app in every existing workspace**
> (re-run its OAuth install link). Until then `conversations.invite` fails `missing_scope` and the
> nag fallback carries the behavior — ship order doesn't matter.

Sam's bot **user id** is resolved per workspace from `slack_identities.slack_bot_user_id`
(populated by the puppet OAuth callback; manually-PUT tokens are backfilled lazily via the
puppet's `auth.test`).

---

## Status

Both earlier gaps are now BUILT:
- **Per-team ears WebClient** — `TenantSlackClients` resolves the ears client + bot user id per
  `team_id` from the `tenants` row (env-token fallback for dev). The directory, surface, and Jarvis
  are all per-workspace; the prod ears serves N workspaces.
- **Puppet OAuth callback** — `/slack/puppet/oauth` (bot id in `state`, creds from
  `SLACK_PUPPET_OAUTH`) captures each install's token into `slack_identities` automatically.

**Apps CREATED 2026-06-11** via `apps.manifest.create` (base URL `https://crew.dltechnologies.co`).
Client ids/secrets + signing secrets + a ready-to-paste `SLACK_PUPPET_OAUTH` value live in
`backend/slack-manifests/.app-credentials.json` (gitignored, mode 600 — never commit).

| App | App ID |
|---|---|
| AI Crew (prod ears) | A0B9X639K4M |
| AI Crew (Dev) (dev ears) | A0BA0HLKJEN |
| Alex | A0B9K3T620P |
| Riley | A0B9X626XGV |
| Maya | A0B9K3S9P7H |
| James | A0B9K3TAQPR |
| Nora | A0BA2CW2389 |
| Sam (team lead) | A0BA0HN8266 |

Remaining (manual — no API for these):
- **App icons**: puppets ← `assets/avatars/illustrated/<botId>.png`; both ears apps ← `assets/slack/app-icon.png`.
- **Dev ears app-level token** (`connections:write`) → `SLACK_APP_TOKEN`; install it into the dev
  workspace and grab `SLACK_BOT_TOKEN` from its OAuth & Permissions page.
- **Activate unlisted distribution** for the prod ears + 6 puppets (Manage Distribution).
- **Deploy env on the box**: `SLACK_SIGNING_SECRET` / `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`
  (ears-prod entry), `SLACK_PUPPET_OAUTH` (precomputed in the credentials file),
  `GATEWAY_PUBLIC_URL=https://crew.dltechnologies.co`.
- **Verify the events URL** once `crew.dltechnologies.co` is live (Slack's challenge must pass
  before events deliver), then Dennis's real-workspace smoke.
