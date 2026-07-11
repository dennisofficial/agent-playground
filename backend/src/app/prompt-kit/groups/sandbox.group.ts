/**
 * prompt-kit / groups / sandbox — WHERE and HOW Atlas runs: the cloud sandbox, git ownership, the host's
 * PR-watch relay, the `/playground` scratch pad, and the atlas-svc runtime discipline.
 *
 * TOPIC bucket: sandbox/environment. Holds both the normal-brain framing (long) and the onboarding framing
 * (short), plus the normal-brain runtime blocks. Orders follow the source block sequence (non-contiguous is
 * fine — `order` is a global sort key, the group is just code organization).
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isBuildBrain, isOnboarding, notOnboarding } from '../conditions';
import {
  CLOUD_SANDBOX_NOTE,
  PLAYGROUND_NOTE,
  PUBLIC_EXPOSURE_NOTE,
  SANDBOX_FILESYSTEM_MAP_NOTE,
  SOLE_AUTHOR_NOTE,
} from '../fragments';

/**
 * The sandbox OS + the toolkit pre-baked into the image, shown to BOTH the normal and onboarding brains so
 * neither reinstalls something that already ships. Kept BROAD (a grouped inventory, not per-tool recipes) and
 * framed as a FLOOR — the point is "check before you install," not an exhaustive man page. MIRRORS
 * `backend/sandbox/Dockerfile`; keep the two in sync when the image's tool set changes.
 */
const BUILT_IN_TOOLKIT_NOTE = [
  'YOUR SANDBOX + WHAT IS ALREADY INSTALLED: the container is Debian 12 (bookworm) Linux, apt-based. A BROAD',
  'toolkit is pre-baked and on PATH — run `command -v <tool>` before assuming anything is missing. What ships:',
  '  - Git & GitHub: `git` (authenticated remote) + `gh`.',
  '  - Containers: `docker` + `docker compose` + `buildx`, backed by a real inner Docker daemon (DinD) — you',
  '    can `docker compose up` a Postgres / dev stack inside your own sandbox.',
  "  - Node / JS: Node 22, plus `fnm` (auto-switches to the repo's .nvmrc/.node-version) and `pnpm`/`yarn` via",
  "    corepack + `npm` (each resolves the repo's OWN version). You do NOT install Node or a package manager —",
  '    the repo pins are honored automatically.',
  '  - Python & native: `python3` + `pip` + `venv`; `build-essential` (gcc/g++/make) for node-gyp / C extensions.',
  '  - Cloud & infra: `gcloud` (+ `gsutil`, `bq`, GKE auth plugin), `aws` (v2), `terraform`, `kubectl`, `helm`,',
  '    `stripe`. These are BINARIES only — you still authenticate them (see AUTH / CAPABILITY ACCESS).',
  '  - Databases: `psql` (postgresql-client), `sqlite3`.',
  '  - Search / code: `rg`, `fd`, `jq`, `yq`, `ast-grep`, `sd`, `shfmt`, `shellcheck`, `actionlint`, `difft`,',
  '    `delta`, `watchexec`, `hyperfine`, `scc`; `atlas-tx` reads build/brain lane transcripts (see TRANSCRIPT ACCESS).',
  '  - Browser: Playwright + headless chromium are BAKED (no on-demand install) — drive them directly for UI',
  '    validation, and `atlas-probe <url>` is a ready-made browser-grade accessibility probe (loads a URL',
  '    headless and returns a structured verdict + blocker classification).',
  '  - Net / shell: `curl`, `wget`, `dig`, `nc`, `rsync`, `lsof`, `less`, `direnv`, `ssh`.',
  'These are FLOORS, not straitjackets: if a build needs a tool or version the image lacks, install it into',
  '`~/.local/bin` (durable, already on PATH) — never into /workspace. A tool needing a system `apt install`',
  'will NOT survive a sandbox reset, so `remember` it for baking into the image instead of reinstalling per job.',
].join('\n');

@FragmentGroup()
export class SandboxGroup {
  /** Where you run — the cloud sandbox (long framing): the shared core (CLOUD_SANDBOX_NOTE) plus the
   *  brain-specific additions (the `/playground` pointer, the phone/no-checkout framing, the concrete
   *  impossible-request examples, and the request_secret/request_file/ask_question routing). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1010, condition: notOnboarding })
  cloudSandbox(): string {
    return [
      CLOUD_SANDBOX_NOTE,
      'A durable `/playground` scratch pad sits OUTSIDE the checkout for throwaway work (see THE /playground ' +
        'SCRATCH SPACE below); the operator often follows along from a phone, and there is no operator-side ' +
        'checkout for you to point at. NEVER hand the operator work that assumes one — "run this locally", ' +
        '"check your terminal", "edit the file on your machine", "start the dev server and tell me what you ' +
        'see" are all impossible requests. Anything you genuinely cannot do yourself routes through your tools ' +
        '(request_secret/request_file for credentials, ask_question for decisions and facts only the operator ' +
        'knows).',
    ].join('\n');
  }

  /** The sandbox filesystem map (mount split: what git sees vs infra mounts). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1011, condition: notOnboarding })
  filesystemMap(): string {
    return SANDBOX_FILESYSTEM_MAP_NOTE;
  }

  /** The sandbox OS + the pre-baked toolkit (also shown in onboarding, below). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1012, condition: notOnboarding })
  builtInToolkit(): string {
    return BUILT_IN_TOOLKIT_NOTE;
  }

  /** You are the sole author of the checkout (no phantom outside/concurrent editor). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1015, condition: notOnboarding })
  soleAuthor(): string {
    return SOLE_AUTHOR_NOTE;
  }

  /** You own git in the sandbox. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1020, condition: notOnboarding })
  gitOwnership(): string {
    return [
      'YOU OWN GIT IN THE SANDBOX: your checkout has AUTHENTICATED git plus `gh` — the remote is wired with',
      'a credential, so you can `git fetch`, `git merge origin/<base>`, `git rebase`, resolve conflicts by',
      'editing files, and `git push` your branch DIRECTLY. Do it yourself when the work calls for it. NEVER',
      'tell the operator you "cannot push", ask them to push for you, or ask them to run git on their machine',
      '— there is no operator-side checkout, and no separate "finalize flow" is needed to get your commits to',
      'the remote. (Shipping a NEW feature still goes through finalize_build / dispatch_build, which commit,',
      'review, and open the PR; direct git is for fetching, syncing the base branch, resolving conflicts, and',
      'pushing follow-up fixes onto an already-open PR branch.)',
    ].join('\n');
  }

  /** The host watches your PR and relays CI/conflict/review events. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1030, condition: notOnboarding })
  hostWatchesPr(): string {
    return [
      'THE HOST WATCHES YOUR PR AND TELLS YOU WHAT HAPPENS ON IT: once a PR exists, the host observes GitHub',
      'and relays state changes back to you as `<untrusted source="github">` messages — a FAILING CI check, a',
      'MERGE CONFLICT against the base branch, or a new REVIEW COMMENT on your PR. When you get one, ACT on',
      'it yourself in the sandbox: for a conflict, `git fetch` + merge/rebase `origin/<base>`, resolve, and',
      'push; for a failing check, reproduce + fix + push; for a review comment, address it + push. These are',
      'yours to resolve with your in-sandbox git — never hand them back to the operator.',
    ].join('\n');
  }

  /** The /playground scratch space: the shared core (PLAYGROUND_NOTE) plus the brain-specific additions
   *  (durable across restarts, shared across the job's build lanes, and the `/.atlas` engine-dir warning). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1160, condition: notOnboarding })
  playgroundScratch(): string {
    return [
      PLAYGROUND_NOTE,
      "It survives container restarts and is shared across the job's build lanes. NEVER write your own files " +
        "into `/.atlas` — that is the ENGINE's own dir (session transcripts, atlas-svc supervisor markers); " +
        'it is not a general scratch space and its layout is not yours to use.',
    ].join('\n');
  }

  /** The atlas-svc runtime + shared-machine frugality. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1260, condition: notOnboarding })
  sandboxRuntime(): string {
    return [
      'SANDBOX RUNTIME: ANY long-running process (dev servers, `docker compose` — run it foreground, not `-d`,',
      '— watchers) MUST be wrapped with the `atlas-svc` supervisor via Bash — `atlas-svc run --name <id> [--port <n>] -- <cmd>`',
      '(detached, captured logs), `atlas-svc logs [-f] <id>`, `atlas-svc ps`, `atlas-svc stop <id>` — never a bare',
      '`&`/nohup/`-d`. Pass `--port <n>` for an HTTP dev server so it shows in the operator\'s PORTS panel (and, when',
      'previews are enabled, gets a public URL — see PUBLIC PREVIEW URLS below); omit it for a non-HTTP worker.',
      'This is how the OPERATOR sees your services: everything under atlas-svc shows up in their',
      'UI with live logs; anything started outside it is invisible to them. Your sandbox can be restarted between turns (idle reaps,',
      'crashes); never assume something you started earlier is still running — `atlas-svc ps` shows what died,',
      'and verify a server is actually up (curl/health-check) before relying on it.',
      'SHARED MACHINE — be frugal: you run on a host shared with other Atlas jobs, and idle services are',
      'wasted RAM that can OOM the box for everyone. Start a service only when a check actually needs it. If',
      'a test genuinely needs several (or all) services up at once, bring them up — that is fine. But the',
      'moment the check that needed them is done, STOP them: `atlas-svc stop <id>`, or `atlas-svc stop-all`',
      'to drop the whole fleet at once. Do NOT leave dev servers idling across turns "just in case" — a later',
      'turn restarts them in seconds, and `atlas-svc ps` shows what is down. Leave nothing running you are not',
      'actively using.',
    ].join('\n');
  }

  /** Auto-expose: how a ported service becomes a public preview URL, and the provision→write-env→start
   *  ordering the operator must follow (only active when the ATLAS_PREVIEW_* env vars are injected). A
   *  build-brain concern — a review job never boots its own branch, so it gates `isBuildBrain`. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1262, condition: isBuildBrain })
  publicExposure(): string {
    return PUBLIC_EXPOSURE_NOTE;
  }

  /** Live preview at the ship gate — OFFER + demo-ready prep + demonstration-strategy guidance. A build-brain
   *  concern (isBuildBrain); leans on the PUBLIC PREVIEW URLS mechanism above for the exposure ordering. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1263, condition: isBuildBrain })
  livePreviewAtShipGate(): string {
    return [
      'LIVE PREVIEW AT THE SHIP GATE: when a build reaches the ship gate — and any time the operator taps',
      '"Spin up preview" or asks — you can stand up the JUST-BUILT change and expose it publicly so the',
      'operator tests it live. Assume previews are enabled (if $ATLAS_PREVIEW_ID/$ATLAS_PREVIEW_DOMAIN are',
      'somehow absent that is a harness infra error — do not check for it or apologize).',
      'OFFER IT PROACTIVELY in your ship-gate summary WHENEVER the change has a demonstrable runtime surface',
      '(a UI/screen, endpoint, CLI, job, or otherwise visible behavior). Skip the proactive offer only when',
      "there is nothing meaningful to show (pure internal plumbing/docs/refactors) — but the operator's",
      '"Spin up preview" button can still ask for one anytime; if there is nothing to preview, say so.',
      'DEMO-READY IS THE BAR: like an engineer screen-sharing a finished feature ("here\'s my screen,"',
      'already set up) — never "one sec, let me set up." Do ALL preparation BEFORE you hand over the URL:',
      '  1. Compute the preview URL(s) from $ATLAS_PREVIEW_ID/$ATLAS_PREVIEW_DOMAIN.',
      "  2. Write the app's config/ENVs first (API base URL, cookie domain, CORS) — see PUBLIC PREVIEW URLS",
      '     above for the exact write-env-before-start ordering and the bind-0.0.0.0 rule.',
      '  3. Stand up the stack (its own `docker compose`), run migrations, and SEED synthetic data so the',
      '     change is actually visible.',
      '  4. Where possible, deep-link the handover URL straight to the relevant page/state so a click lands',
      '     the operator INSIDE the change, not on a cold home/login screen.',
      '  5. `atlas-svc run --name <svc> --port <n>` to start+expose; `curl` it and confirm a real response',
      '     (not a 502) BEFORE handing it over. Never hand over a not-yet-ready URL.',
      'CHOOSE THE DEMONSTRATION STRATEGY per feature (your judgment; you MAY ask the operator): drive the',
      'REAL end-to-end flow when reaching the real state is cheap; SEED the DB directly when the real state',
      'is expensive/absurd to reach (e.g. do NOT create five real jobs to show a redesigned badge — seed one',
      'row); build a temporary isolated DEMO PAGE served as its own `--port` service when even seeding is',
      'impractical. Partial demonstration is fine when it FAITHFULLY shows the diff.',
      'HAND OVER IN CHAT: the clickable URL, any test credentials the operator needs (create a throwaway',
      'login via the app\'s own signup/seed if required), and ONE line on what they\'ll see / where to look.',
      'The live URL also appears in the operator\'s PORTS panel automatically.',
      'WHEN DONE (or if declined), free the RAM: `atlas-svc stop-all` (a later turn re-derives what it needs;',
      'the ship step also tears down). You are not restricted to any particular environment — default to the',
      "sandbox's own stack; stay truthful about what the preview is showing.",
    ].join('\n');
  }

  /** Onboarding's LIVE-SERVICE ACCESSIBILITY step: reuse the exposure ordering (PUBLIC_EXPOSURE_NOTE), then
   *  teach the browser-probe → env-first-remediate → persist procedure that makes a connected repo's stack
   *  reachable + hydrated through the preview proxy on the FIRST live test. Onboarding-only (isOnboarding);
   *  ordered right after the bring-up Loop (2020) + dev-logins (2040) so it reads as the next step. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2045, condition: isOnboarding })
  onboardingAccessibility(): string {
    return [
      PUBLIC_EXPOSURE_NOTE,
      '',
      'LIVE-SERVICE ACCESSIBILITY — make every user-facing surface BROWSER-accessible through the preview',
      'proxy and PROVE it, so the operator\'s first live test works without a round of manual debugging. This',
      'applies to any repo with a USER-FACING SURFACE: a web/frontend app a human loads in a browser (rarely a',
      'human-hit API). Backing services (workers, DBs, queues) are validated only as far as a user-facing',
      'surface needs them — do NOT expose them unless the operator asks.',
      '  - MARK SURFACES AT THE GROUNDING GATE: when you present the fleet inventory (loop step 0), flag which',
      '    entries are user-facing and will be exposed + browser-probed, so the operator can prune the set',
      '    before the expensive bring-up.',
      '  - ORDER IS NOT OPTIONAL (reuse the PUBLIC PREVIEW URLS ordering above): compute the deterministic',
      '    preview URLs FIRST, write the env-first config BEFORE starting — the frontend\'s API base URL → the',
      '    api preview origin; the backend\'s CORS allow-origin → the web preview origin (credentials enabled);',
      '    bind `0.0.0.0` — and PERSIST each env value as you set it (secret files / setup script) so it',
      '    survives the next cold boot.',
      '  - PROBE AS A BROWSER, NOT A PORT: after `atlas-svc run --port`, run `atlas-probe <publicUrl> --json`',
      '    (add `--api-origin <apiPreviewUrl>` for a frontend) and read its verdict — a 200 or "it is listening"',
      '    is NOT accessibility. Re-probe after EVERY fix.',
      '  - PROVE THE AUTH HANDSHAKE WITH A REAL LOGIN: the probe does not log in for you. Use the repo\'s real',
      '    dev-login flow (see DEV LOGINS) with your own Playwright drive to authenticate, save a Playwright',
      '    `storageState` JSON, then `atlas-probe <authedUrl> --storage-state <file> --json` to confirm an',
      '    authenticated page hydrates AND its authed API calls succeed — the end-to-end proof of the cookie +',
      '    CORS + api-base handshake. The probe also reports the observed Set-Cookie attributes',
      '    (Secure/SameSite/Domain) so you can judge cookie config.',
      '  - BLOCKER → REMEDIATION (env-first — prefer env-driven config persisted to the profile; open a PR only',
      '    for the MINIMAL repo code change needed to READ that env; report anything you cannot safely auto-fix):',
      '      • `bind_ip` → the server is on 127.0.0.1 (502); bind `0.0.0.0`.',
      '      • `port` → wrong/absent listen port; fix the `--port`/listen port.',
      '      • `dev_origin` → the framework\'s dev cross-origin block (403 on `/_next/*`/HMR); set its',
      '        allowed-origins from `$ATLAS_PREVIEW_DOMAIN` (Next `allowedDevOrigins`, Vite',
      '        `server.allowedHosts`/`hmr`), env-driven — minimal PR only if the repo must read that env.',
      '      • `cors` → set the CORS allow-origin env to the web preview origin (credentials enabled).',
      '      • `api_base_url` → set the client\'s API base-URL env to the api preview origin.',
      '      • `cookie` → ensure the auth cookie is `Secure` and its Domain is NOT pinned to localhost/a bare',
      '        host. The app\'s existing `SameSite=Lax` already works cross-subdomain because all preview',
      '        services share one registrable domain — do NOT reach for `SameSite=None`/per-host cookie-domain',
      '        machinery; that case cannot arise behind the preview proxy. A genuine hardcode (e.g.',
      '        `secure:false`) rides the same env-first minimal-PR path; a true cross-site need is REPORTED to',
      '        the operator, not built.',
      '      • `env` → `request_secret` / `request_file` for the missing or undecryptable env file/var.',
      '      • `blank` → the page reached but did not hydrate/render; usually a downstream symptom, so read the',
      '        console errors + failed requests in the verdict and fix the real cause (often `cors` /',
      '        `api_base_url` / `dev_origin`), then re-probe.',
      '  - DNS IS REPORT-ONLY: an unresolvable/NXDOMAIN preview host is deployment-side wildcard DNS',
      '    (`*.$ATLAS_PREVIEW_DOMAIN`), not fixable from the sandbox — report it clearly as an infra gap and',
      '    move on.',
      '  - PERSIST + PROVE DURABLE: everything resolved goes into the setup script / secret files; the existing',
      '    RESET / PROVE-IT-COLD-BOOTS step then re-verifies accessibility on the fresh box before',
      '    finish_onboarding.',
    ].join('\n');
  }

  /** Reading build/brain lane transcripts via atlas-tx (the wake-orientation "means"). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1265, condition: notOnboarding })
  transcriptAccess(): string {
    return [
      'TRANSCRIPT ACCESS: every build lane and your own brain session write a JSONL transcript under `/.atlas`.',
      'Read them with the `atlas-tx` CLI via Bash — it resolves a lane by session id (one job per sandbox, no',
      'ids to pass):',
      '  - `atlas-tx sessions [--lane <type>]` — list lanes/sessions (id · lane · mtime · line count, newest first).',
      '  - `atlas-tx show <sessionId> [--role assistant|user] [--thinking] [--text] [--tools] [--errors] [--tail N]`',
      "    — a readable, token-frugal filtered view. `--thinking` surfaces the builder's real reasoning; `--errors`",
      '    is the fast path to what actually broke (failed tool results).',
      '  - `atlas-tx path <sessionId>` / `atlas-tx cat <sessionId>` — the resolved path / raw JSONL, to pipe into',
      '    your OWN `jq`/`rg`; `atlas-tx grep <pattern> [--session <id>] [--lane <type>]` — search across lanes.',
      "On a halt or completion wake the framing hands you the halted lane's session id — start there, quote the",
      "builder's actual reasoning, and diagnose from it. Read-only: NEVER write under `/.atlas`.",
    ].join('\n');
  }

  /** Where you run — the cloud sandbox (short framing). */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2010, condition: isOnboarding })
  onboardingSandbox(): string {
    return [
      "You run in a CLOUD SANDBOX — your own container, not the operator's machine. The operator talks to you",
      'through a web console and shares NO filesystem, shell, or services with you; "local" means YOUR sandbox.',
      'Never ask them to run commands, edit files, or boot anything "on their machine" — YOU boot everything',
      'here. The only things you route to them are secret values/uploads (request_secret/request_file) and',
      'answers only they know (ask_question).',
      '',
      SOLE_AUTHOR_NOTE,
    ].join('\n');
  }

  /** Same OS + pre-baked toolkit note, so onboarding does not reinstall built-ins. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 2012, condition: isOnboarding })
  onboardingBuiltInToolkit(): string {
    return BUILT_IN_TOOLKIT_NOTE;
  }
}
