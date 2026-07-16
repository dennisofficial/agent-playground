/**
 * The `NotificationSource` edge — the INBOUND-ONLY notification edge. Where a `ChatSurface` is duplex
 * (post + `inbound$`, bound to a thread), a `NotificationSource` only ever EMITS: it parses + verifies +
 * routes a gateway's webhook payload into one `ParsedEvent` (the intake seam then mints the `EventMessage`
 * it delivers). It has NO reply path — a notification routes to the owning job's brain and every further
 * exchange happens over the `ChatSurface`. (See `../ARCHITECTURE.md` §7.)
 *
 * Each gateway gets its OWN adapter (GitHub, generic webhook, later Sentry/PostHog/email) because
 * gateways are not equal: each owns its payload shape, signature/auth VERIFICATION, `dedupeKey`
 * derivation, SEVERITY mapping, and PROJECT ROUTING. The ONLY shared contract is the OUTPUT
 * (`ParsedEvent` → `EventMessage`, `trust: 'untrusted'`) and everything downstream of it — so new gateways
 * are trivially extensible drop-ins.
 */

import type { EventKind } from './message';
import type { EventSeverity } from './seed-row';

/**
 * The raw HTTP request an ingress controller hands an adapter — the exact bytes (for HMAC), the
 * headers (signature + delivery id), and the already-parsed JSON body. Adapters read what they need;
 * the controller is gateway-agnostic plumbing.
 */
export interface RawNotification {
  /** The EXACT request body bytes — signature HMAC must cover these, never a re-serialized object. */
  rawBody: Buffer;
  /** Lower-cased header map (e.g. 'x-hub-signature-256', 'x-github-delivery', 'x-github-event'). */
  headers: Record<string, string | undefined>;
  /** The parsed JSON body (best-effort; adapters that need the raw bytes use `rawBody`). */
  body: unknown;
}

/**
 * What verification + parsing yields BEFORE the intake mints the message id / persists rows. The
 * adapter has already done routing (`orgId`/`repoId`), dedupe-key derivation, and severity mapping; the
 * intake seam adds the id, `receivedAt`, `jobId` (the owning thread), and the `type:'event'`/`trust`
 * invariants when it builds the `EventMessage`. `eventKind` is the render-time discriminant threaded from
 * ingress into the transcript row's `meta`. `correlation` is TRANSIENT — consumed once at routing
 * (`resolveOwningJob`), never persisted onto the event row.
 *
 * A standalone shape (not `Omit<EventMessage, …>`) because the routing `correlation` here permits `null`
 * branch/PR values the adapters emit, which the persisted `EventMessage.correlation` deliberately does not.
 */
export type ParsedEvent = {
  orgId: string;
  repoId: string;
  source: string;
  dedupeKey: string;
  severity: EventSeverity;
  eventKind: EventKind;
  body: string;
  correlation?: { branch?: string | null; prNumber?: number | null };
  resumeThreadId?: string;
};

/** Why an adapter rejected a request — surfaced as the HTTP status the controller returns. */
export type IngressRejectionReason =
  | 'bad-signature' // HMAC / shared-secret mismatch → 401
  | 'unverifiable' // missing signature header / no secret configured → 401
  | 'unroutable' // payload doesn't map to a known atlas_project → 404
  | 'unsupported' // a payload shape this adapter deliberately ignores (e.g. a GitHub ping) → 202
  | 'malformed'; // unparseable / missing required fields → 400

/** A parsed GitHub `pull_request` webhook delta the silent PR-state sync applies (NOT a stimulus). */
export type PrStateDelta = {
  orgId: string;
  repoId: string;
  action: 'opened' | 'closed' | 'reopened';
  prNumber: number;
  headRef: string;
  url: string;
  merged: boolean;
};

/**
 * A parsed GitHub CI webhook (`check_run`/`check_suite`/`workflow_run`) correlation delta the silent
 * CI-status sync recomputes against. Carries ONLY correlation keys — deliberately NOT the webhook's own
 * head_sha: GitHub does not guarantee webhook delivery order, so recompute always reads the CURRENT PR
 * head instead (an old commit's delayed CI webhook must never set the badge from its own SHA).
 */
export interface CiSyncDelta {
  orgId: string;
  repoId: string;
  prNumber: number | null;
  branch: string | null;
}

/**
 * An adapter's verdict on a raw notification. `accepted` carries the parsed event the intake then
 * normalizes; `rejected`/`ignored` carry a reason the controller maps to a status. `ignored` is a
 * SUCCESSFUL no-op (a verified-but-uninteresting payload, e.g. GitHub's `ping`), distinct from a
 * `rejected` (verification/routing failure). `pr-sync` is a SILENT authoritative PR-state delta
 * (open/merged/closed/reopened) applied directly to the owning job's row — it never seeds a stimulus.
 * For the GitHub adapter this is emitted only by `handlePrWebhook` (the `/webhooks/github/state` front
 * door), never by `handle` (the `/webhooks/github/events` work-events front door). `repo-push` is a
 * verified push to a repo's DEFAULT branch — the state door marks that repo's open PRs due-now so the
 * reconciler catches a base-move-induced conflict in seconds (GitHub emits no webhook for one). `pr-rearm`
 * is a mergeability-affecting webhook that touches exactly ONE PR (head push, draft↔ready) — the state
 * door re-arms that PR's fast poll via `GitStateReconciler.markJobDue` rather than fanning out a base-move
 * REST refresh across every open PR.
 */
export type IngressResult =
  | { outcome: 'accepted'; event: ParsedEvent }
  | { outcome: 'ignored'; reason: IngressRejectionReason; detail?: string }
  | { outcome: 'rejected'; reason: IngressRejectionReason; detail?: string }
  | { outcome: 'pr-sync'; delta: PrStateDelta }
  | { outcome: 'repo-push'; orgId: string; repoId: string }
  | {
      outcome: 'pr-rearm';
      orgId: string;
      repoId: string;
      prNumber?: number | null;
      branch?: string | null;
    };

/**
 * The inbound-only port every gateway adapter implements. One method: take a `RawNotification`, do
 * gateway-specific verification + parsing + routing, return an `IngressResult`. No reply, no post,
 * no `inbound$` — that asymmetry vs. `ChatSurface` IS the point.
 */
export interface NotificationSource {
  /** The gateway id this adapter handles, e.g. 'github' | 'webhook'. Becomes the `EventMessage.source`. */
  readonly source: string;
  /** Verify + parse + route a raw notification into a `ParsedEvent` (or reject/ignore it). */
  handle(raw: RawNotification): Promise<IngressResult>;
}
