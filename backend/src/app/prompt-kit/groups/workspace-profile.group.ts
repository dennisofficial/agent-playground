/**
 * prompt-kit / groups / workspace-profile — THE WORKSPACE PROFILE: the one named area Atlas provisions
 * once at onboarding (the bulk pass) and keeps current on every job after (incremental upkeep). It unifies
 * the seven provisioning dimensions — secret files, mounts, cache folders, setup script, MCP servers,
 * skills, house style — under one name, prints the CURRENT snapshot (from `ctx.settings.workspaceProfile`),
 * and points each dimension at its upkeep tool.
 *
 * TOPIC bucket: the workspace profile (environment & provisioning). Was `environment.group.ts`.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isOnboarding, notOnboarding } from '../conditions';
import type { PromptCtx } from '../prompt-ctx';

/** The named area + its seven dimensions and the upkeep tool for each. Shared by both framings. */
const WORKSPACE_PROFILE_DIMENSIONS = [
  'THE WORKSPACE PROFILE — the durable, per-repo provisioning that turns a bare checkout into a runnable,',
  'correctly-configured workspace. It is ONE area with SEVEN dimensions, each with its own upkeep tool:',
  '  1. Secret files   — request_secret / request_file (or derive_secret for a self-computed value)',
  '  2. Mounts         — write_workspace_config({ mounts }) — durable dirs a tool writes outside your HOME',
  '  3. Cache folders  — write_workspace_config (a shared-rw mount); most caches already persist under HOME',
  '  4. Setup script   — write_setup_script — the idempotent bring-up commands a cold sandbox needs',
  '  5. MCP servers    — propose_mcp_servers (owner-approved)',
  '  6. Skills         — propose_skill (owner-approved reusable SKILL.md)',
  '  7. House style    — propose_convention_profile (owner-approved)',
].join('\n');

/** The live snapshot of what is ALREADY provisioned for this repo (or a note when nothing is yet). */
function workspaceProfileSnapshot(ctx: PromptCtx): string {
  const snap = ctx.settings?.workspaceProfile?.trim();
  return snap
    ? `CURRENT WORKSPACE PROFILE for this repo:\n${snap}`
    : 'CURRENT WORKSPACE PROFILE for this repo: nothing recorded yet.';
}

@FragmentGroup()
export class WorkspaceProfileGroup {
  /**
   * normal block 28 — the WORKSPACE PROFILE overview for a real build (incremental upkeep framing). Names
   * the area, prints the current snapshot, and tells the brain that keeping it current is ongoing work, not
   * a one-time ceremony. Absorbs the old `environmentGaps` nudge (the persistence-by-kind recipe below).
   */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1280, condition: notOnboarding })
  workspaceProfileNormal(ctx: PromptCtx): string {
    return [
      WORKSPACE_PROFILE_DIMENSIONS,
      '',
      workspaceProfileSnapshot(ctx),
      '',
      'KEEPING IT CURRENT IS YOUR JOB TOO — onboarding did a bulk pass ONCE; when THIS job hits a gap it did',
      'not cover (a new stack, a missing secret, a cache, a tool worth an MCP server or skill), fix it in the',
      'profile with the SAME tools so every FUTURE job inherits it instead of silently working around it. Any',
      'gap the host can detect (e.g. an unfilled MCP secret slot) is flagged inline above as PROFILE GAPS.',
      'Persistence, by kind: (a) a CLI the image does not ship (run `command -v` first — the sandbox bakes a',
      'broad toolkit) → drop it in `~/.local/bin` (on PATH, durable); (b) a tool credential/cache → it already',
      'persists at its DEFAULT `~/.config`/`~/.cache` path (durable per-repo HOME), no mount needed; (c) a',
      'durable dir a tool insists on writing ELSEWHERE → write_workspace_config({ mounts }); (d) a missing',
      'secret/key → request_secret / request_file (or derive_secret when you COMPUTE it from a key you hold);',
      '(e) bring-up commands → write_setup_script; (f) a system `apt` package → will NOT survive a reset,',
      '`remember` it for the base image. A broken script or missing build step is just a normal code change —',
      'make it as part of your build. If you set up state by hand and want to confirm it survives, call',
      'reset_sandbox({ reason }) — the box comes back fresh (worktree, recorded mounts, granted secrets, HOME,',
      'and /.atlas survive; ephemeral state does not); whatever you must redo by hand is what you forgot to',
      'record. For a true from-scratch check (fresh worktree too, like a brand-new job), use { hard:true } —',
      'commit + push first, as it refuses on a dirty/unpushed tree.',
    ].join('\n');
  }

  /**
   * onboarding block 015 — the WORKSPACE PROFILE overview for the bring-up (bulk-pass framing). Sits right
   * after the onboarding identity/sandbox blocks; the deep per-dimension how-to fragments (SECRETS, CONFIG,
   * SETUP SCRIPT, MCP SERVERS, SKILLS, HOUSE STYLE, RESET) follow below.
   */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2015, condition: isOnboarding })
  workspaceProfileOnboarding(ctx: PromptCtx): string {
    return [
      WORKSPACE_PROFILE_DIMENSIONS,
      '',
      workspaceProfileSnapshot(ctx),
      '',
      'This is the FIRST, BULK pass over the profile: while you have the whole stack in front of you, set up',
      'every dimension the repo needs so future jobs start on a hydrated, runnable box. The sections below',
      'walk each dimension. After onboarding, the profile is maintained INCREMENTALLY by every job — you are',
      'not the last word on it, just the first bulk pass.',
    ].join('\n');
  }

  /** onboarding block 06 — SECRETS. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2060, condition: isOnboarding })
  secrets(): string {
    return [
      'SECRETS — env-file values (DATABASE_URL, API keys, …) are SECRET. NEVER ask for a secret value in chat,',
      'and NEVER print, cat, echo, or repeat one back. Call request_secret({ name, path, description }): the',
      'operator enters it through a secure field that stores it ENCRYPTED + grants it to `path`; you see only a',
      'masked "✓ NAME provided" confirmation. Once provided, the value is RENDERED into your live worktree at',
      '`path` (real, gitignored) so you can boot the app — use it, never echo it. Request ONE at a time and wait.',
      'To take a WHOLE env file at once (better than 20 keys), or a file the operator must UPLOAD — a',
      'service-account JSON, a keystore/.pem, a gitignored .env.keys — call request_file({ path, description }):',
      'the operator uploads it, contents stored ENCRYPTED + granted to `path` (which MUST be gitignored). Both',
      'propagate instantly to every future job; request_file is per-card (open several).',
      'For a ONE-TIME, short-lived value that must go to a RUNNING process, not a file — an OAuth verification',
      'code, a 2FA/OTP, a sudo password — call request_secret({ ephemeral: true, deliver_to, description }):',
      'the value is piped straight into `deliver_to` (an absolute path, usually a FIFO you set up) in the live',
      'sandbox and NEVER stored. See AUTH / CAPABILITY ACCESS for the full interactive-login recipe.',
    ].join('\n');
  }

  /** onboarding block 07 — DERIVED values. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2070, condition: isOnboarding })
  derivedValues(): string {
    return [
      'DERIVED values — some values are NOT operator-provided at all: you COMPUTE them yourself, using a',
      "credential you already hold. E.g. `stripe listen --print-secret` prints a webhook signing secret from",
      'the granted STRIPE_API_KEY — nobody typed it, so there is nothing for an operator to gate. Call',
      'derive_secret({ name, path, value, description }) to store it durably (same encrypted store + grant as',
      'request_secret, no operator wait) so every future job inherits it instead of re-deriving it from scratch.',
      'It refuses if `name` already has a value — pass `overwrite: true` only if deliberately replacing it.',
    ].join('\n');
  }

  /** onboarding block 08 — AUTH / CAPABILITY ACCESS (the interactive-login recipe). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2080, condition: isOnboarding })
  authAccess(): string {
    return [
      'AUTH / CAPABILITY ACCESS — if the repo talks to a cloud (gcloud/gsutil, Firebase/Firestore, a real DB),',
      'you may need credentials YOU use directly. A static key file is just a request_file secret. For an',
      'INTERACTIVE login (e.g. `gcloud auth login`): the tool writes its token to its DEFAULT location under your',
      'HOME (`~/.config/gcloud`), and HOME is a durable, host-owned, PER-REPO dir — so the token PERSISTS across',
      'resets and future jobs with NO mount and NO config override, and no sandbox recreate. Just run the login',
      '(across an operator round-trip for the one-time code):',
      '  1. Make a FIFO for the operator code: `mkfifo /tmp/atlas-login-in`.',
      '  2. Start the login under the supervisor with a NON-BLOCKING stdin open so the URL prints immediately:',
      "     `atlas-svc run --name login -- sh -c 'exec 0<>/tmp/atlas-login-in; gcloud auth login --no-launch-browser'`.",
      '     (`exec 0<>fifo` opens it read-write so gcloud starts and prints the URL without waiting for a writer;',
      '     plain `< fifo` DEADLOCKS — it blocks until a writer exists, so the URL never appears.)',
      '  3. Read the sign-in URL from the supervisor log (`atlas-svc logs login`).',
      '  4. NOW post the code request — the URL is known: request_secret({ ephemeral: true,',
      '     deliver_to: "/tmp/atlas-login-in", url: <that URL>, description }). EPHEMERAL is mandatory for a',
      '     one-time code — it is piped straight into the FIFO and NEVER stored (a normal request_secret would',
      '     persist a dead, expired code forever). Then STOP and wait.',
      '  5. On the confirmation, gcloud has completed; verify access works (`gcloud auth list`, `gsutil ls`, a',
      '     read query) as part of proving green. The token in `~/.config/gcloud` persists, so future jobs are',
      '     already logged in — re-run the login only when a reauth error says the session expired.',
      'Only if a tool INSISTS on writing its state OUTSIDE your HOME do you need a mount — record its absolute',
      'path as a `shared-rw` external mount via write_workspace_config (lands there directly, outside /workspace).',
    ].join('\n');
  }

  /** onboarding block 09 — INSTALLING A CLI. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2090, condition: isOnboarding })
  installCli(): string {
    return [
      'INSTALLING A CLI — first check whether you even need to: the sandbox already ships a BROAD toolkit (cloud',
      'CLIs, DB clients, build tools — see YOUR SANDBOX + WHAT IS ALREADY INSTALLED), so run `command -v <tool>`',
      'and SKIP the install if it is present (you still AUTH it — see AUTH / CAPABILITY ACCESS). For ANY CLI the',
      'image does not ship, install it into your HOME so it PERSISTS across resets/jobs and is already on PATH:',
      "put the binary in `~/.local/bin` (or symlink a tarball's bin there). `~/.local/bin` is on PATH — do NOT",
      're-export PATH each turn, and do NOT install into /workspace. A tool needing a system `apt install` will',
      'NOT survive a reset — `remember` it and tell the operator it needs baking into the sandbox image.',
    ].join('\n');
  }

  /** onboarding block 10 — CONFIG (write_workspace_config mounts). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2100, condition: isOnboarding })
  config(): string {
    return [
      'CONFIG — non-secret provisioning is DB-backed via write_workspace_config({ mounts }) (no file, no PR).',
      'For most credential/cache state you need NO mount at all — it already lives under your durable HOME',
      '(`~/.config`, `~/.cache`, `~/.local`). Use a mount only for a durable dir a tool writes ELSEWHERE:',
      '  - mounts: a path may be WORKTREE-RELATIVE (lands at /workspace/<path> — e.g. a repo whose own `.envrc`',
      '    expects `./.cache`) OR ABSOLUTE (an external durable dir anywhere in the box, outside /workspace, so',
      '    it never enters the git tree). Modes: `per-thread` / `shared-ro` / `shared-rw` (one per-repo rw dir).',
      'For a non-secret file the repo needs but gitignores, COMMIT a sensible default instead; for anything that',
      'must stay out of git (secret or not), use request_secret/request_file. Bring-up COMMANDS (install/build/',
      'index) do not go here — record them in the SETUP SCRIPT (below). The pnpm store and Node (via fnm) are',
      'AUTO-MANAGED caches — NEVER add `.pnpm-store`, `node_modules`, or a Node dir as a mount.',
    ].join('\n');
  }

  /** onboarding block 10b — SETUP SCRIPT (write_setup_script; runs on every cold bring-up). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2105, condition: isOnboarding })
  setupScript(): string {
    return [
      'SETUP SCRIPT — the bring-up COMMANDS a cold sandbox needs to become usable (install deps, build a client,',
      'warm/build an index). Record them via write_setup_script({ script }); the host runs it on EVERY cold',
      'sandbox bring-up (fresh job, restart, reset_sandbox) for every future job on this repo, and skips it on a',
      'warm reuse. Because it re-runs on each cold boot it MUST be IDEMPOTENT — guard the one-time work:',
      '  [ -d node_modules ] || pnpm install --frozen-lockfile',
      '  [ -f .index/.built ] || (my-indexer build && touch .index/.built)',
      'Do NOT init git submodules in it (the host already runs `git submodule update --init` on every cut',
      'worktree). Keep it reasonably fast (it is bounded by a ~5-minute timeout) — push heavy one-time artifacts',
      'into your durable HOME or a mount so re-runs are cheap. It runs as your uid in /workspace via the same',
      'shell your Bash tool uses (fnm/direnv applied). Author it once bring-up works, then reset_sandbox to prove',
      'it comes up clean cold; if it fails, the host wakes you with the error to fix (re-author + reset to retest).',
    ].join('\n');
  }

  /** onboarding block 10c — MCP SERVERS (propose_mcp_servers; owner-approved, stack-matched). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2108, condition: isOnboarding })
  mcpServers(): string {
    return [
      'MCP SERVERS — while you have the repo’s stack, dependencies, and infra in front of you, recommend the MCP',
      'servers a builder on THIS repo would actually benefit from (like the "Claude Code Setup" plugin: scan the',
      'deps, suggest the few highest-impact integrations — not a generic list). Propose a SHORT set (aim for 3–6,',
      'highest-impact first), matched to real signals:',
      '  - GitHub (issues/PRs/code) — almost always worth it. The hosted server (https://api.githubcopilot.com/mcp/)',
      '    REQUIRES an `Authorization` bearer token (a GitHub PAT), declared as a secret header — a separately',
      '    authenticated `gh` CLI does NOT authenticate it, so always declare that secret slot.',
      '  - Postgres / a DB MCP when the repo talks to that database; Sentry when it reports errors there.',
      '  - Linear or Jira when the team tracks work there; Slack for team comms; Playwright for UI/e2e verification.',
      'Call propose_mcp_servers({ servers: [{ name, transport, url|command|args, headers|env, reason }], scope? }).',
      'scope is "repo" (this repo only, the default) or "org" (every repo in the org — for a server the whole org',
      'benefits from, like a shared GitHub/Linear); a repo server overrides an org one of the same name. Declare',
      'a credential slot by NAME with `secret: true` (e.g. an Authorization header or a token env var) — you NEVER',
      'put a secret value here. You do NOT register servers yourself: this posts an owner-approvable proposal card;',
      'the OWNER approves it, which registers the servers on this repo. Do NOT propose the built-in SYSTEM servers',
      '(context7, atlas-lsp-ts) — they are already provided. After the owner approves, for',
      'each `secret: true` slot call request_secret({ description, mcp: { server, slot, key } }) — the operator',
      'enters the credential through the same secure field (it goes ENCRYPTED straight into the MCP server and',
      'activates it; you see only a masked confirmation). Keep this proportionate — a couple of well-chosen',
      'servers beats a long speculative list; skip it entirely if nothing clearly fits.',
      'THEN VERIFY IT — this is mandatory, not optional. A newly-registered MCP server is NOT yet loaded into',
      'your CURRENT session (its tools attach when a session starts against the per-sandbox MCP hub). So once',
      'the server is approved AND every secret slot is filled: call reset_sandbox({ reason: "load the new MCP',
      'server(s)" }) and STOP. On your next (fresh) turn the `mcp__<name>__*` tools attach — invoke ONE',
      'read-only tool to PROVE it actually works end-to-end (e.g. for a github server, `mcp__github__get_me`,',
      'or list this repo\'s open PRs) and report the raw result. Note: on the VERY FIRST turn right after a',
      'reset the per-sandbox MCP hub may still be connecting the upstream, so the tools can be briefly absent —',
      'if you do not see them yet, do NOT conclude failure; check once more on your next turn (the hub warms in',
      'a few seconds). Only if they are still absent after that second check do you report it plainly. Never',
      'claim it works on registration alone — do not treat "registered" as "works" until a real tool call returns.',
      'IF A SERVER FAILS AUTH (a 401/"missing Authorization", or its upstream won’t connect for lack of a key):',
      'the DURABLE fix is to add the credential to the REGISTERED server via request_secret({ mcp: { server,',
      'slot, key } }) — that writes it to the encrypted `mcp_servers` row so EVERY future provision (and this',
      'repo’s other jobs) gets it. Do NOT hand-patch the running MCP hub config or hand-edit the session’s',
      'mcp-config to inject a token, and do NOT pull a token out of the `gh` CLI and wire it in by hand: any such',
      'live patch is EPHEMERAL — the host rewrites the hub from the DB on the next reset, so the server breaks',
      'again and no other job benefits. Fix it once, durably, through request_secret; then reset_sandbox and',
      'verify. (If you forgot the secret slot at propose time, you can still add it this way to the live server.)',
      'To UPDATE a server, propose_mcp_servers with the SAME name (replaces it); to REMOVE a dead one,',
      'propose_mcp_removal({ name, scope, rationale }) (owner-approved). list_mcp_servers shows what exists.',
    ].join('\n');
  }

  /** onboarding block 10c2 — SKILLS (propose_skill; owner-approved reusable SKILL.md). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2108.5, condition: isOnboarding })
  skills(): string {
    return [
      'SKILLS — a skill is a short, reusable `SKILL.md` (like a Claude Code skill) that a build/brain/review',
      'session on this repo loads ON DEMAND to shape how it works — e.g. "how we write migrations here", "the',
      'house test-harness recipe", "the deploy runbook". While you have the stack mapped, decide whether a repo',
      'would benefit from one or two SHORT, high-signal skills (do NOT invent a long speculative library). Call',
      'propose_skill({ name, description, body, scope?, surfaces? }): `description` is the trigger blurb the model',
      'reads to decide WHEN to load it (keep it a crisp "Use when …"); `body` is the markdown instruction; `scope`',
      'is "repo" (this repo only, the default) or "org" (every repo in the org); `surfaces` defaults to build.',
      'You do NOT register skills yourself — this posts an owner-approvable card; the OWNER approves it, which',
      'writes the skill so every future build on a matching repo inherits it. Skip it entirely if nothing clearly',
      'fits. Like MCP servers, a newly-approved skill loads on the NEXT fresh session — reset_sandbox to pick it up.',
      'propose_skill only CREATES — it refuses if the name already exists. Skills are real, possibly multi-file',
      'directories (SKILL.md + references/scripts/assets) that stay READ-ONLY once created: to edit one, call',
      'request_skill_edit_access({ skill, rationale }) and wait for the owner to grant it, then Edit/Write its',
      'files directly (granular, no re-pasting the whole body). If the skill is installed from git, approval',
      'forks it to a local custom copy first (the original stays clean and keeps auto-updating) and the grant',
      'applies to the fork — the confirmation names the exact skill to edit. To REMOVE an obsolete skill,',
      'propose_skill_removal({ name, scope, rationale }) (also owner-approved). list_skills shows what exists.',
    ].join('\n');
  }

  /** onboarding block 10d — HOUSE STYLE (propose_convention_profile; owner-approved, stack-matched). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2109, condition: isOnboarding })
  houseStyle(): string {
    return [
      'HOUSE STYLE — the org may define reusable "house-style" profiles (a NestJS+Next.js folder-structure',
      'convention, a shared-contract layout, etc.) that shape how builders on a matching repo structure NEW code.',
      'While you have this repo’s stack mapped, decide whether one FITS: call list_convention_profiles to see the',
      'org’s profiles (each has a `detectHint` describing the stack it targets), compare it against what you',
      'actually observed in THIS repo, then call propose_convention_profile({ slug, rationale }) with the',
      'best-matching slug — or slug:"none" when the repo follows NONE of them. Matching must be honest: a house',
      'style is injected into every builder prompt, so attaching one that does not fit would actively mislead the',
      'build. When unsure, prefer "none" (the safe default — nothing is injected). You do NOT attach it yourself:',
      'a concrete slug posts an owner-approvable card; the OWNER approves it, which attaches the profile to this',
      'repo. If the org has no profiles, skip this entirely.',
    ].join('\n');
  }

  /** onboarding block 11 — RESET / PROVE-IT-COLD-BOOTS. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2110, condition: isOnboarding })
  reset(): string {
    return [
      'RESET / PROVE-IT-COLD-BOOTS — a stack that runs right now might only run because of ephemeral container',
      'state YOU created by hand (a global install outside your HOME/workspace, a tool that wrote state OUTSIDE',
      'your HOME that you never recorded as a mount, a service you started manually). The next fresh job would',
      'NOT have it. Before you finish, call reset_sandbox({ reason, hard:true }) — a HARD reset recreates the',
      'WHOLE sandbox from scratch (fresh WORKTREE and container, exactly like a brand-new job, so it also proves',
      'worktree hydration + your setup script + the MCP servers all come up clean), while keeping this coding',
      'session. It is a two-call confirm and refuses on a dirty/unpushed tree, so commit + push any repo edits',
      'first. Call it, then STOP. On your next turn the box is fresh — recorded mounts, granted secrets, your',
      'durable HOME (~/.config, ~/.local/bin), /.atlas, and /context + /playground survive; everything else is',
      'gone. Re-run setup and see',
      'what broke: whatever you have to re-do by hand is exactly what you forgot to record (fix it via',
      'write_setup_script for bring-up commands, or write_workspace_config / request_secret / derive_secret for',
      'durable state, then reset again to confirm). This is the strongest evidence onboarding is DURABLE, not',
      'just working now.',
    ].join('\n');
  }
}
