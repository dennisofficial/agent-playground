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
} from '@shared/domain';
import { BaseMoveMergeabilitySync } from '../driver/base-move-mergeability-sync.service';
import { GitStateReconciler } from '../driver/git-state-reconciler.service';
import { GithubCiStateSync } from '../driver/github-ci-state-sync.service';
import { GithubPrStateSync } from '../driver/github-pr-state-sync.service';
import { IntakeOutcome, StimulusIntake } from '../stimulus/stimulus-intake.service';
import type { GithubNotificationSource } from './github-notification.source';

export interface RawBodyRequest {
  rawBody?: Buffer;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

export function toRawNotification(req: RawBodyRequest): RawNotification {
  return {
    rawBody:
      req.rawBody ??
      Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})),
    headers: normalizeHeaders(req.headers),
    body: req.body,
  };
}

export async function runIngress(
  logger: Logger,
  adapter: NotificationSource,
  intake: StimulusIntake,
  req: RawBodyRequest,
): Promise<Record<string, unknown>> {
  const result: IngressResult = await adapter.handle(toRawNotification(req));
  return mapTriageToHttp(logger, adapter, intake, result);
}

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
    return { status: 'ignored', reason: 'unsupported' };
  }

  const outcome: IntakeOutcome = await intake.intakeEvent(result.event);
  if (!outcome.admitted) {
    const status = outcome.reason === 'no-owner' ? 'ignored' : 'deduped';
    return { status, reason: outcome.reason, detail: outcome.detail };
  }
  return {
    status: 'accepted',
    stimulusId: outcome.stimulusId,
    jobId: outcome.jobId,
  };
}

export async function runWorkEvent(
  logger: Logger,
  adapter: GithubNotificationSource,
  intake: StimulusIntake,
  ciSync: GithubCiStateSync,
  reconciler: GitStateReconciler,
  req: RawBodyRequest,
): Promise<Record<string, unknown>> {
  const { triage, ci, rearm } = await adapter.handleWorkEvent(toRawNotification(req));
  if (ci) ciSync.schedule(ci); // fire-and-forget, debounced — never blocks the 202 or the triage path
  if (rearm) {
    await reconciler.markJobDue(rearm.orgId, rearm.repoId, {
      prNumber: rearm.prNumber ?? undefined,
      branch: rearm.branch ?? undefined,
    });
  }
  return mapTriageToHttp(logger, adapter, intake, triage);
}

export async function runPrWebhook(
  logger: Logger,
  adapter: GithubNotificationSource,
  req: RawBodyRequest,
  prSync: GithubPrStateSync,
  reconciler: GitStateReconciler,
  baseMove: BaseMoveMergeabilitySync,
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
    baseMove.schedule(result.orgId, result.repoId);
    return { status: 'accepted' };
  }
  if (result.outcome === 'pr-rearm') {
    await reconciler.markJobDue(result.orgId, result.repoId, {
      prNumber: result.prNumber ?? undefined,
      branch: result.branch ?? undefined,
    });
    return { status: 'accepted' };
  }

  return { status: 'ignored', reason: 'unsupported' };
}

function rejectionToHttp(reason: IngressRejectionReason, detail?: string): HttpException {
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
      return new HttpException(detail ?? 'unsupported', HttpStatus.ACCEPTED);
  }
}
