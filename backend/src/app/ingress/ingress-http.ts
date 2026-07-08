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
import type { GithubPrStateSync } from '../driver';

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
 *  - accepted + admitted  → 202 { status:'accepted', stimulusId, jobId }
 *  - accepted + deduped   → 202 { status:'deduped', reason }
 *  - ignored              → 202 { status:'ignored', reason }   (verified but no action — a success)
 *  - pr-sync              → 202 { status:'accepted' }   (silent PR-state delta — dispatched, not intaken)
 *  - rejected:bad-signature / unverifiable → 401
 *  - rejected:unroutable  → 404
 *  - rejected:malformed   → 400
 */
export async function runIngress(
  logger: Logger,
  adapter: NotificationSource,
  intake: StimulusIntake,
  req: RawBodyRequest,
  prSync?: GithubPrStateSync,
): Promise<Record<string, unknown>> {
  const result: IngressResult = await adapter.handle(toRawNotification(req));

  if (result.outcome === 'rejected') {
    logger.warn(`${adapter.source} rejected (${result.reason}): ${result.detail ?? ''}`);
    throw rejectionToHttp(result.reason, result.detail);
  }
  if (result.outcome === 'ignored') {
    logger.debug(`${adapter.source} ignored (${result.reason}): ${result.detail ?? ''}`);
    return { status: 'ignored', reason: result.reason };
  }
  if (result.outcome === 'pr-sync') {
    if (prSync) await prSync.dispatch(result.delta);
    return { status: 'accepted' };
  }

  const outcome: IntakeOutcome = await intake.intakeEvent(result.event);
  if (!outcome.admitted) {
    return { status: 'deduped', reason: outcome.reason, detail: outcome.detail };
  }
  return {
    status: 'accepted',
    stimulusId: outcome.stimulusId,
    jobId: outcome.jobId,
  };
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
