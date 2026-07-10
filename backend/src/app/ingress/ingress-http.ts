import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  IngressRejectionReason,
  IngressResult,
  NotificationSource,
  RawNotification,
} from '../domain';
import type { IntakeOutcome, StimulusIntake } from '../stimulus';
import type { GithubCiStateSync, GithubPrStateSync, GitStateReconciler } from '../driver';
import type { GithubNotificationSource } from './github-notification.source';

/** Express request shape the ingress controllers read (rawBody enabled on the Nest app). */
export interface RawBodyRequest {
  rawBody?: Buffer;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** Lower-case + flatten the header map an adapter reads (signature, delivery id, event type). */
export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/** Build the gateway-agnostic `RawNotification` from a raw-body Express request. */
export function toRawNotification(req: RawBodyRequest): RawNotification {
  return {
    // The HMAC must cover the EXACT bytes Slack/GitHub sent — never a re-serialized object. `rawBody`
    // is present because the Atlas HTTP app is created with `rawBody: true`.
    rawBody: req.rawBody ?? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})),
    headers: normalizeHeaders(req.headers),
    body: req.body,
  };
}

/**
 * Run an adapter on a raw request and feed an accepted event into the intake, mapping the combined
 * `IngressResult` + `IntakeOutcome` to an HTTP response. The controllers are thin: this is the shared
 * verify → intake → status plumbing so every gateway controller behaves identically.
 *
 * Status mapping (a webhook caller reads these):
 *  - accepted + admitted   → 202 { status:'accepted', stimulusId, jobId }
 *  - admitted:false no-owner → 202 { status:'ignored', reason:'no-owner' }  (route-only: nothing owns it)
 *  - admitted:false dup/rate → 202 { status:'deduped', reason }
 *  - ignored               → 202 { status:'ignored', reason }   (verified but no action — a success)
 *  - rejected:bad-signature / unverifiable → 401
 *  - rejected:unroutable   → 404
 *  - rejected:malformed    → 400
 *
 * A `pr-sync` outcome can never reach this path — `adapter.handle()` no longer emits one (see
 * `runPrWebhook`, the silent PR-state front door's counterpart).
 */
export async function runIngress(
  logger: Logger,
  adapter: NotificationSource,
  intake: StimulusIntake,
  req: RawBodyRequest,
): Promise<Record<string, unknown>> {
  const result: IngressResult = await adapter.handle(toRawNotification(req));
  return mapTriageToHttp(logger, adapter, intake, result);
}

/**
 * Map a triage `IngressResult` (already verified/routed/parsed by an adapter) to the intake → HTTP status
 * plumbing shared by every work-events door. Extracted from `runIngress` so `runWorkEvent` (the door that
 * ALSO schedules the silent CI-status sync) can reuse the identical mapping.
 */
export async function mapTriageToHttp(
  logger: Logger,
  adapter: NotificationSource,
  intake: StimulusIntake,
  result: IngressResult,
): Promise<Record<string, unknown>> {
  if (result.outcome === 'rejected') {
    logger.warn(`${adapter.source} rejected (${result.reason}): ${result.detail ?? ''}`);
    throw rejectionToHttp(result.reason, result.detail);
  }
  if (result.outcome === 'ignored') {
    logger.debug(`${adapter.source} ignored (${result.reason}): ${result.detail ?? ''}`);
    return { status: 'ignored', reason: result.reason };
  }
  if (result.outcome !== 'accepted') {
    // Unreachable via `handle()` (only `handlePrWebhook` emits 'pr-sync') — kept for exhaustiveness.
    return { status: 'ignored', reason: 'unsupported' };
  }

  const outcome: IntakeOutcome = await intake.intakeEvent(result.event);
  if (!outcome.admitted) {
    // 'no-owner' = a verified event nothing owns → a deliberate no-op (route-only, d6), reported as a
    // success like 'ignored'. 'duplicate'/'rate-limited' = collapsed by the firehose filter → 'deduped'.
    const status = outcome.reason === 'no-owner' ? 'ignored' : 'deduped';
    return { status, reason: outcome.reason, detail: outcome.detail };
  }
  return {
    status: 'accepted',
    stimulusId: outcome.stimulusId,
    jobId: outcome.jobId,
  };
}

/**
 * `/webhooks/github/events` front door — triage same as `runIngress`, PLUS scheduling the silent
 * CI-status sync from the SAME verified/routed payload (`GithubNotificationSource.handleWorkEvent`
 * parses both in one pass so they can never disagree). The CI schedule is fire-and-forget/debounced —
 * it never blocks the 202 response or the triage path.
 */
export async function runWorkEvent(
  logger: Logger,
  adapter: GithubNotificationSource,
  intake: StimulusIntake,
  ciSync: GithubCiStateSync,
  req: RawBodyRequest,
): Promise<Record<string, unknown>> {
  const { triage, ci } = await adapter.handleWorkEvent(toRawNotification(req));
  if (ci) ciSync.schedule(ci); // fire-and-forget, debounced — never blocks the 202 or the triage path
  return mapTriageToHttp(logger, adapter, intake, triage);
}

/**
 * Run the GitHub adapter's PR-state front door (`/webhooks/github/state`): verify + route, then dispatch
 * by outcome — a `pull_request` event's `PrStateDelta` goes straight to the silent `GithubPrStateSync`,
 * and a `repo-push` (a push to the repo's default branch) marks the repo's open PRs due-now via
 * `GitStateReconciler.markRepoDue` so the fast heartbeat catches a base-move conflict in seconds. This
 * path never touches `StimulusIntake`.
 */
export async function runPrWebhook(
  logger: Logger,
  adapter: GithubNotificationSource,
  req: RawBodyRequest,
  prSync: GithubPrStateSync,
  reconciler: GitStateReconciler,
): Promise<Record<string, unknown>> {
  const result: IngressResult = await adapter.handlePrWebhook(toRawNotification(req));

  if (result.outcome === 'rejected') {
    logger.warn(`${adapter.source} rejected (${result.reason}): ${result.detail ?? ''}`);
    throw rejectionToHttp(result.reason, result.detail);
  }
  if (result.outcome === 'ignored') {
    logger.debug(`${adapter.source} ignored (${result.reason}): ${result.detail ?? ''}`);
    return { status: 'ignored', reason: result.reason };
  }
  if (result.outcome === 'pr-sync') {
    await prSync.dispatch(result.delta);
    return { status: 'accepted' };
  }
  if (result.outcome === 'repo-push') {
    const marked = await reconciler.markRepoDue(result.orgId, result.repoId);
    return { status: 'accepted', marked };
  }

  return { status: 'ignored', reason: 'unsupported' };
}

function rejectionToHttp(
  reason: IngressRejectionReason,
  detail?: string,
): HttpException {
  switch (reason) {
    case 'bad-signature':
    case 'unverifiable':
      return new UnauthorizedException(detail ?? 'signature verification failed');
    case 'unroutable':
      return new NotFoundException(detail ?? 'no project routes this notification');
    case 'malformed':
      return new BadRequestException(detail ?? 'malformed payload');
    case 'unsupported':
    default:
      // An 'unsupported' rejection (rare — adapters prefer 'ignored') maps to 202 no-op semantics.
      return new HttpException(detail ?? 'unsupported', HttpStatus.ACCEPTED);
  }
}
