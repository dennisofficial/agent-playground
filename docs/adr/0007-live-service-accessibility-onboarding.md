# ADR 0007 — Live-service accessibility is proven and persisted during onboarding

- **Status:** Accepted — implemented.
- **Date:** 2026-07-11
- **Relates to:** ADR 0002 (onboarding as a hydration manifest, not a boot recipe), ADR 0003 (workspace
  config in the DB, not git), ADR 0005 (live-verification judge). Canonical narrative:
  `backend/src/app/onboarding/REDESIGN.md`; onboarding + workspace-profile model in
  `backend/src/app/ARCHITECTURE.md`.

## Context

Onboarding already proves a repo *runs* — the ceremony boots the fleet headlessly and captures the secrets,
auth state, and mounts a future job needs (ADR-0002). But "runs" was proven only LOCALLY: a service listening
on a port inside the sandbox, checked with a `curl` to `127.0.0.1`. The moment an operator wanted a LIVE test
of the connected stack — the app actually reachable and hydrated **in a browser through the preview proxy** —
a predictable class of blockers surfaced, and each was debugged manually, one at a time, every time:

- **wildcard preview DNS** — `*.PREVIEW_BASE_DOMAIN` not resolving, so the public host is NXDOMAIN;
- **bind IP** — the server listening on `127.0.0.1` instead of `0.0.0.0`, so the proxy gets a 502;
- **framework dev cross-origin block** — e.g. Next's dev server 403-ing `/_next/*`/HMR from the preview
  origin because it isn't in the dev allowlist;
- **CORS** — the API rejecting the web origin;
- **client→API base URL** — the browser bundle pointing at `localhost`/the wrong origin instead of the
  API's public preview origin;
- **cookie flags** — the auth cookie not `Secure`, or domain-pinned to `localhost`, so it is never sent
  back over the HTTPS preview host.

None of this was captured anywhere, so it recurred on the next job and the next repo. Onboarding is an
agentic brain job (`jobKind === 'onboarding'`), not a deterministic backend check, so the fix belongs in the
brain's guidance and its tools — not a new backend gate or a new profile dimension. The two constraints that
shaped the design: **no new DB table / workspace-profile dimension and no new `OnboardingStep`** (the resolved
config persists into the EXISTING setup-script + secret-file dimensions), and **the cookie/CORS reality behind
the preview proxy is same-registrable-domain**, so no general cross-site machinery is warranted.

## Decision

Onboarding now makes every **user-facing surface** (a service a human accesses in a browser — the web/frontend
app, occasionally a directly-hit API) **browser-accessible through the preview proxy, proves it as a browser,
and persists the resolved config** — so every future job on the repo inherits a working, browser-reachable
stack. Delivered as three parts, reusing existing persistence (`write_setup_script` + secret files) and
exposure (`atlas-svc run` + `ExposureService`/Caddy reconcile) unchanged.

### 1. `isOnboarding` prompt-kit guidance (the procedure) — d1

New `isOnboarding` fragments teach the expose → probe → remediate → persist loop, seeded at thread start and
carried in the onboarding prompt (`backend/src/app/prompt-kit`). The brain:

- **Identifies user-facing surfaces** in the fleet inventory (marks the subset that a human loads in a
  browser; backing workers/DBs/queues are validated only as far as a surface needs them).
- **Exposes** each surface via the preview proxy in a deterministic order: the public URL is known BEFORE
  start (`https://$ATLAS_PREVIEW_ID-<svc>.$ATLAS_PREVIEW_DOMAIN`), so write the env FIRST (compute + persist
  the preview origins), bind the server to `0.0.0.0`, then `atlas-svc run --name <svc> --port <n>` and let
  Caddy reconcile the route.
- **Probes end-to-end as a browser** with `atlas-probe` against the PUBLIC preview URL (see part 2).
- **Remediates env-first** on a blocker (see below), then re-probes until green.
- **Persists** the resolved config to the workspace profile (setup script + secret files) so it re-hydrates
  for every future job.

### 2. The `atlas-probe` helper (the browser-grade verdict) — d1, d5

A small, framework-agnostic helper baked into the sandbox image (`backend/sandbox/Dockerfile`,
`backend/sandbox/atlas-probe`) loads the public preview URL headless in Playwright chromium and returns a
structured verdict (loads / hydrates / assets serve) plus a **classified blocker** on failure:
`dns` (NXDOMAIN / unresolvable preview host), `bind_ip` (502 from a `127.0.0.1` bind), `port` (nothing
listening), `dev_origin` (framework dev cross-origin 403), `cors` (API rejects the web origin),
`api_base_url` (bundle points at the wrong API origin), `cookie` (auth cookie not sent), `blank` (loads but
never hydrates). Given a session the brain establishes through the repo's REAL dev-login, `--storage-state`
(+ `--api-origin`) re-probes to prove the authed cookie/CORS handshake, not just the anonymous page.

Playwright + chromium are **baked into the image** (retiring the previous per-onboarding on-demand install)
so the hydration check is reliable and instant; the probe is reusable by build brains and the `validate`
subagent, and is advertised in `BUILT_IN_TOOLKIT_NOTE`. "Reachable" therefore means reachable through the
preview proxy AS A BROWSER — not a port check and not a localhost curl.

### 3. Env-first remediation, minimal-PR only when code must read env — d2, d4

For repo-CODE accessibility blockers (dev-origin allowlist, CORS allow-origin, cookie `Secure`/domain, the
client→API base URL), the brain remediates **env-first**: make the config env-driven and persist the resolved
values to the workspace profile; open a PR only for the MINIMAL repo code change needed to READ that env — the
worked example being `allowedDevOrigins` driven by `ATLAS_PREVIEW_DOMAIN` (already merged; the reference, not
part of this diff). Anything that can't be safely and minimally auto-fixed is REPORTED to the operator rather
than force-edited. Repo edits ride the existing `finish_onboarding` PR path.

Cookie/CORS remediation is **bounded to the preview same-registrable-domain model**: all preview services
share one registrable domain, so CORS allow-origin and the client→API base URL are just env config set to the
computed preview origins, and the auth cookie needs only to be `Secure` and not `localhost`-pinned — the app's
existing `SameSite=Lax` already works. We deliberately DO NOT build general cross-site machinery
(`SameSite=None` + per-host cookie-domain override): that case cannot arise behind the preview proxy. A genuine
cross-site need is documented as report-only guidance, not built.

**DNS is report-only.** Wildcard preview DNS (`*.PREVIEW_BASE_DOMAIN`) is a one-time DEPLOYMENT concern, not
per-repo; the probe DETECTS and reports an unresolvable preview host but cannot (and does not) auto-fix
Cloudflare.

### 4. Strengthened `finish_onboarding` green-gate — d3

No new deterministic checklist step and no org-lifecycle coupling. The existing `finish_onboarding`
green-gate is strengthened so its `verified` evidence must include **live preview-accessibility proof for each
user-facing surface** — the public preview URL actually loaded and hydrated as a browser via `atlas-probe`.
Accessibility stays per-repo agentic validation carried by the onboarding thread, NOT a step on the
org-credentials onboarding checklist. Implemented via prompt / tool-description wording and the
`finish_onboarding` handler's `verified` guidance, not a new `OnboardingStep`.

## Consequences

**Positive.** The whole manual-debugging class ("expose the stack, then chase DNS → bind IP → dev-origin →
CORS → API base URL → cookie one at a time") is solved ONCE, during onboarding, and its resolution persists
into the workspace profile — so every future job inherits a browser-accessible stack with zero re-derivation.
`atlas-probe` is a reusable, framework-agnostic browser-grade check that build brains and the `validate`
subagent get for free, and baking Playwright + chromium makes it instant and reliable. "Onboarded" now means
"loads and hydrates in a browser through the preview proxy," a materially stronger bar than "listens on a
port."

**Negative / costs.** The wildcard-DNS prerequisite remains a one-time deployment concern the probe can only
DETECT and report, not fix — a genuinely unresolvable preview host still needs an operator/infra action. The
accessibility bar lives in prompt/tool-description wording and the `finish_onboarding` `verified` guidance
rather than a hard-coded backend check, so it is enforced by the same agentic-plus-green-gate mechanism as the
rest of the ceremony (consistent with ADR-0002/0005, but not a deterministic assertion). The baked browser
adds image size.

**Explicitly NOT done (scope bounds).** No new DB table or workspace-profile dimension; no new `OnboardingStep`
or org-lifecycle coupling. No general cross-site cookie/CORS machinery (`SameSite=None`, per-host
cookie-domain override) — the preview proxy's same-registrable-domain reality means it cannot arise. A related
ship-gate live-preview idea was split to ticket #27 (out of scope here).
