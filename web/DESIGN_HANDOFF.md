# Atlas web — design handoff

The backend now models **Organization → Users(members) → Repos → Threads**, with a web onboarding API and multi-org support. This note covers the parts that differ from a standard single-workspace app. (It complements the earlier onboarding-wizard UI gap list.)

## North star: one login, many orgs, **unified — no switching**

A person logs in **once** and belongs to many orgs — some they own (e.g. HannibalAI, Cubixhosts, Personal), some they're invited to (a teammate's / family member's project). They routinely work across all of them at the same time.

**Do not build a workspace switcher** (Slack/Linear-style "you are now in workspace X"). That's the exact friction we're avoiding. Instead, model it like a **mail client with a unified inbox**: every account's mail in one list, each item tagged with its account, and replying uses the right account automatically. The org is a **label/filter, never a mode**.

### The shell

- **Multi-root sidebar** — every org the user owns *or* is invited to is shown at once, each a collapsible root with its repos nested under it. Color/badge per org. No "current org."
- **"All threads" inbox = the home** — one list of threads across *all* orgs, each row chip-tagged with its org + repo (e.g. `HannibalAI · web`), newest first. This is the primary surface the user lives in. A per-org / per-repo filter narrows it; the default is everything.
- **New thread** — one action that picks org → repo, then drops into the conversation. The thread transparently runs on that org's credentials; the user never manages tokens per action.
- **Org status** — an org is `onboarding` until it has validated credentials + a connected repo, then `active`. Surface a gentle "finish setup" affordance on `onboarding` orgs; only `active` orgs can start threads.

### Org settings + members + invites (per org)

- **Members** — list of members with role (owner/admin/member).
- **Invite** — owner/admin enters an email → gets a **copy-paste invite link** (no email is sent). They share it however they like. The invitee opens the link, logs in/signs up, sees a small "Join **HannibalAI**?" preview, and accepts.
- **Pending invites** — list with a revoke action.

## API the frontend calls

All `/web/*` use the session cookie (credentialed CORS to `NEXT_PUBLIC_ATLAS_HTTP_URL`). `/web/orgs/:orgId/*` additionally require membership (403 otherwise).

```
GET    /auth/session                         -> { id, email, name, orgs:[{id,slug,name,role,status}] }   # route: no orgs → onboarding
GET    /web/threads                          -> [{ threadId, title, origin, createdAt, org:{id,slug,name}, repo:{id,name} }]  # the unified inbox (all orgs)

POST   /web/orgs            {name}           -> {id,slug,name,status,role}
GET    /web/orgs                             -> [{id,slug,name,status,role}]
GET    /web/orgs/:orgId                      -> {…org, onboarding:{lifecycle,steps,missing}}
GET    /web/orgs/:orgId/onboarding           -> {status, steps, missing}
PUT    /web/orgs/:orgId/credentials  {anthropicApiKey?,openaiApiKey?,githubPat?,engineAuthMode,engineAuthSecret?}
GET    /web/orgs/:orgId/credentials          -> {hasAnthropic,hasOpenai,hasGithub,engineAuthSet,llmValidated}   # masked
POST   /web/orgs/:orgId/repos       {repoUrl,baseBranch?,displayName?} -> {repoId,name,gitUrl,defaultBranch,accessOk}
GET    /web/orgs/:orgId/repos                -> [{id,slug,name,gitUrl,defaultBranch,accessOk}]

GET    /web/orgs/:orgId/members              -> [{userId,email,name,role}]
POST   /web/orgs/:orgId/invites     {email,role?}  -> {token,email,role,link,invitedBy,createdAt}   # `link` is copy-paste
GET    /web/orgs/:orgId/invites              -> [pending invites]
DELETE /web/orgs/:orgId/invites/:token       -> {ok}
GET    /web/invites/:token                   -> {orgId,orgName,email,role,accepted}   # accept screen preview (login required)
POST   /web/invites/:token/accept            -> {orgId}                                # idempotent

# per-thread (org+repo scoped)
GET/POST  /web/orgs/:orgId/repos/:repoId/threads          # list / create({firstMessage,title?,baseBranch?}) -> {threadId}
GET       /web/orgs/:orgId/repos/:repoId/events  (SSE)
GET       /web/orgs/:orgId/repos/:repoId/threads/:threadId/messages
POST      /web/orgs/:orgId/repos/:repoId/threads/:threadId/say  {text}
POST      /web/orgs/:orgId/repos/:repoId/threads/:threadId/approve {actionId,value,ruledBy,note?}
GET       /web/orgs/:orgId/repos/:repoId/threads/:threadId/pipeline
DELETE    /web/orgs/:orgId/repos/:repoId/threads/:threadId
```

> Heads-up for the frontend dev: the current `web/` app still calls the removed `/web/say` / `/web/channels` / `/web/thread` endpoints. The post-login workspace needs rewiring to the routes above.
