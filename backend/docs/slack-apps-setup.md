# Slack apps setup (single-process multi-tenant)

The harness uses a **two-tier** Slack app topology. After the single-process refactor, all tokens
are stored per workspace (`team_id`) in the DB, so each app is created ONCE and installed into every
workspace via **unlisted distribution**.

## App inventory

| App | Count | Transport | Job |
|---|---|---|---|
| **AI Crew (Dev)** | 1 | **Socket Mode ONLY** | Local-dev ears (event listener). Local quick-edit/test only. |
| **AI Crew** (prod) | 1 | **Events API / HTTP ONLY** | Deployed-prod ears: the one event listener + fallback poster. |
| **Puppet: Alex/Maya/Nora/James/Sam/Riley** | 6 | HTTP, no events | Each posts + reacts as that employee (real bot user, name + avatar). |

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

> Replace `https://YOUR_HOST` with the deployed base URL. The dev ears app has NO request URLs
> (Socket Mode delivers events/interactivity over the websocket).

### Prod ears — `AI Crew` (Events API)

```yaml
display_information:
  name: AI Crew
features:
  bot_user:
    display_name: AI Crew
    always_online: true
oauth_config:
  redirect_urls:
    - https://YOUR_HOST/slack/oauth
  scopes:
    bot:
      - chat:write
      - chat:write.customize   # fallback posting as employees (username/icon override)
      - reactions:write
      - channels:read
      - channels:history
      - channels:join
      - groups:read
      - groups:history
      - users:read
settings:
  event_subscriptions:
    request_url: https://YOUR_HOST/slack/events
    bot_events:
      - message.channels
      - message.groups
      - member_joined_channel
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: https://YOUR_HOST/slack/interactivity
  socket_mode_enabled: false
  org_deploy_enabled: false
```

### Dev ears — `AI Crew (Dev)` (Socket Mode)

Same `bot` scopes as prod. Differences: `socket_mode_enabled: true`, NO request URLs, and you must
mint an **app-level token** (`connections:write`) — that's the `xapp-…` you put in `SLACK_APP_TOKEN`.
Subscribe to the same `bot_events`; enable Interactivity (delivered over the socket, no URL).

### Puppet (template — one per employee)

```yaml
display_information:
  name: Alex            # → Maya / Nora / James / Sam / Riley
features:
  bot_user:
    display_name: Alex  # this is the name + (with an app icon) the avatar shown on posts/reactions
    always_online: true
oauth_config:
  redirect_urls:
    - https://YOUR_HOST/slack/oauth   # only used if you wire the puppet-OAuth callback (see below)
  scopes:
    bot:
      - chat:write
      - reactions:write
      - channels:join     # auto-join public channels on first post; private channels must invite the bot
settings:
  socket_mode_enabled: false
  org_deploy_enabled: false
  # no event_subscriptions, no interactivity — puppets never listen
```

Set each puppet's **app icon** to that employee's avatar (`web/public/avatars/<style>/<botId>.png`) so
posts/reactions carry the face.

---

## Setup steps

1. **Create the apps** (api.slack.com/apps → "From a manifest"): the prod ears, the dev ears, and the
   6 puppets, using the manifests above.
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

---

## Status

Both earlier gaps are now BUILT:
- **Per-team ears WebClient** — `TenantSlackClients` resolves the ears client + bot user id per
  `team_id` from the `tenants` row (env-token fallback for dev). The directory, surface, and Jarvis
  are all per-workspace; the prod ears serves N workspaces.
- **Puppet OAuth callback** — `/slack/puppet/oauth` (bot id in `state`, creds from
  `SLACK_PUPPET_OAUTH`) captures each install's token into `slack_identities` automatically.

Remaining: Dennis's real-workspace smoke; create + distribute the apps per the manifests above; set
`SLACK_PUPPET_OAUTH` on the box.
