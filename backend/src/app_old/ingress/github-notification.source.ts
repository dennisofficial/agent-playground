import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import type {
  CiSyncDelta,
  EventKind,
  EventSeverity,
  IngressResult,
  NotificationSource,
  ParsedEvent,
  PrStateDelta,
  RawNotification,
} from '../../_shared/domain';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProjectRoutingService } from '../stimulus/project-routing.service';

@Injectable()
export class GithubNotificationSource implements NotificationSource {
  readonly source = 'github';
  private readonly logger = new Logger(GithubNotificationSource.name);

  constructor(
    private readonly env: EnvService,
    private readonly routing: ProjectRoutingService,
  ) {}

  async handle(raw: RawNotification): Promise<IngressResult> {
    const g = await this.verifyAndRoute(raw);
    if ('outcome' in g) return g;
    return this.buildTriage(g, raw);
  }

  async handleWorkEvent(raw: RawNotification): Promise<{
    triage: IngressResult;
    ci: CiSyncDelta | null;
    rearm: RearmTarget | null;
  }> {
    const g = await this.verifyAndRoute(raw);
    if ('outcome' in g) return { triage: g, ci: null, rearm: null };
    const triage = this.buildTriage(g, raw);
    const ci = parseCiDelta(g.eventType, g.route, g.body);
    const rearm = parseRearmDelta(g.eventType, g.route, g.body);
    return { triage, ci, rearm };
  }

  private buildTriage(
    g: {
      eventType: string;
      body: GithubWebhookBody;
      route: { orgId: string; repoId: string };
    },
    raw: RawNotification,
  ): IngressResult {
    const summary = summarizeGithubEvent(g.eventType, g.body);
    if (!summary) {
      return {
        outcome: 'ignored',
        reason: 'unsupported',
        detail: `github ${g.eventType} (no action)`,
      };
    }

    const event: ParsedEvent = {
      orgId: g.route.orgId,
      repoId: g.route.repoId,
      source: this.source,
      dedupeKey: deriveDedupeKey(g.eventType, g.body, raw.headers['x-github-delivery']),
      severity: summary.severity,
      eventKind: summary.eventKind,
      body: summary.body,
      ...(summary.correlation ? { correlation: summary.correlation } : {}),
    };
    return { outcome: 'accepted', event };
  }

  async handlePrWebhook(raw: RawNotification): Promise<IngressResult> {
    const g = await this.verifyAndRoute(raw);
    if ('outcome' in g) return g;
    if (g.eventType === 'push') {
      return this.parsePush(g.route, g.body);
    }
    if (g.eventType !== 'pull_request') {
      return {
        outcome: 'ignored',
        reason: 'unsupported',
        detail: `github ${g.eventType} (not a pull_request event)`,
      };
    }
    return this.parsePullRequest(g.route, g.body);
  }

  private async verifyAndRoute(raw: RawNotification): Promise<
    | IngressResult
    | {
        eventType: string;
        body: GithubWebhookBody;
        route: { orgId: string; repoId: string };
      }
  > {
    const secret = this.env.get('GITHUB_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.warn('GITHUB_WEBHOOK_SECRET unset — refusing GitHub webhook');
      return {
        outcome: 'rejected',
        reason: 'unverifiable',
        detail: 'no webhook secret configured',
      };
    }

    const signature = raw.headers['x-hub-signature-256'];
    if (!signature) {
      return {
        outcome: 'rejected',
        reason: 'unverifiable',
        detail: 'missing X-Hub-Signature-256',
      };
    }
    if (!verifyGithubSignature(raw.rawBody, signature, secret)) {
      return {
        outcome: 'rejected',
        reason: 'bad-signature',
        detail: 'X-Hub-Signature-256 mismatch',
      };
    }

    const eventType = raw.headers['x-github-event'] ?? 'unknown';
    if (eventType === 'ping') {
      return {
        outcome: 'ignored',
        reason: 'unsupported',
        detail: 'github ping',
      };
    }

    const body = raw.body as GithubWebhookBody;
    const repo = body?.repository?.full_name;
    if (!repo) {
      return {
        outcome: 'rejected',
        reason: 'malformed',
        detail: 'missing repository.full_name',
      };
    }

    const route = await this.routing.routeGithubRepo(repo);
    if (!route) {
      return {
        outcome: 'rejected',
        reason: 'unroutable',
        detail: `no atlas_project for repo ${repo}`,
      };
    }

    return { eventType, body, route };
  }

  private parsePullRequest(
    route: { orgId: string; repoId: string },
    body: GithubWebhookBody,
  ): IngressResult {
    const action = body.action;
    const pr = body.pull_request;
    if (
      action === 'synchronize' ||
      action === 'ready_for_review' ||
      action === 'converted_to_draft'
    ) {
      if (pr?.number == null) {
        return {
          outcome: 'ignored',
          reason: 'unsupported',
          detail: 'pull_request missing number',
        };
      }
      return {
        outcome: 'pr-rearm',
        orgId: route.orgId,
        repoId: route.repoId,
        prNumber: pr.number,
        branch: pr.head?.ref ?? null,
      };
    }
    if (action !== 'opened' && action !== 'reopened' && action !== 'closed') {
      return {
        outcome: 'ignored',
        reason: 'unsupported',
        detail: `github pull_request ${action ?? '?'} (no action)`,
      };
    }
    if (pr?.number == null) {
      return {
        outcome: 'ignored',
        reason: 'unsupported',
        detail: 'pull_request missing number',
      };
    }
    const delta: PrStateDelta = {
      orgId: route.orgId,
      repoId: route.repoId,
      action,
      prNumber: pr.number,
      headRef: pr.head?.ref ?? '',
      url: pr.html_url ?? '',
      merged: pr.merged ?? false,
    };
    return { outcome: 'pr-sync', delta };
  }

  private parsePush(
    route: { orgId: string; repoId: string },
    body: GithubWebhookBody,
  ): IngressResult {
    const ref = body.ref;
    const defaultBranch = body.repository?.default_branch;
    if (!ref || !defaultBranch || ref !== `refs/heads/${defaultBranch}`) {
      return {
        outcome: 'ignored',
        reason: 'unsupported',
        detail: `github push to non-default ref ${ref ?? '?'}`,
      };
    }
    return { outcome: 'repo-push', orgId: route.orgId, repoId: route.repoId };
  }
}

interface GithubWebhookBody {
  action?: string;
  ref?: string;
  repository?: { full_name?: string; default_branch?: string };
  workflow_run?: {
    id?: number;
    name?: string;
    conclusion?: string;
    status?: string;
    html_url?: string;
    head_branch?: string;
    head_sha?: string;
    pull_requests?: Array<{ number?: number; head?: { ref?: string } }>;
  };
  check_run?: {
    id?: number;
    name?: string;
    conclusion?: string;
    status?: string;
    html_url?: string;
    head_sha?: string;
    check_suite?: { head_branch?: string };
    pull_requests?: Array<{ number?: number; head?: { ref?: string } }>;
  };
  check_suite?: {
    id?: number;
    conclusion?: string;
    status?: string;
    head_branch?: string;
    head_sha?: string;
    pull_requests?: Array<{ number?: number }>;
  };
  pull_request?: {
    number?: number;
    html_url?: string;
    merged?: boolean;
    head?: { ref?: string };
  };
  review?: {
    id?: number;
    state?: string;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
  };
  comment?: {
    id?: number;
    body?: string | null;
    html_url?: string;
    user?: { login?: string };
  };
  issue?: { number?: number; pull_request?: unknown };
  sender?: { login?: string; type?: string };
}

interface EventSummary {
  severity: EventSeverity;
  eventKind: EventKind;
  body: string;
  correlation?: { branch?: string | null; prNumber?: number | null };
}

export function verifyGithubSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function summarizeGithubEvent(eventType: string, body: GithubWebhookBody): EventSummary | null {
  const repo = body.repository?.full_name;
  if (eventType === 'workflow_run') {
    const run = body.workflow_run;
    if (run?.status !== 'completed') return null;
    if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
      return {
        severity: 'critical',
        eventKind: 'ci_failure',
        body: `GitHub Actions workflow "${run.name ?? 'unknown'}" ${run.conclusion} in ${repo}.\n${run.html_url ?? ''}`.trim(),
        correlation: {
          branch: run.head_branch ?? null,
          prNumber: run.pull_requests?.[0]?.number ?? null,
        },
      };
    }
    return null;
  }
  if (eventType === 'check_run') {
    const check = body.check_run;
    if (check?.status !== 'completed') return null;
    if (check.conclusion === 'failure' || check.conclusion === 'timed_out') {
      return {
        severity: 'critical',
        eventKind: 'ci_failure',
        body: `GitHub check "${check.name ?? 'unknown'}" ${check.conclusion} in ${repo}.\n${check.html_url ?? ''}`.trim(),
        correlation: {
          branch: checkRunBranch(check),
          prNumber: check.pull_requests?.[0]?.number ?? null,
        },
      };
    }
    return null;
  }
  if (eventType === 'check_suite') {
    const suite = body.check_suite;
    if (suite?.status !== 'completed') return null;
    if (suite.conclusion === 'failure') {
      return {
        severity: 'critical',
        eventKind: 'ci_failure',
        body: `GitHub check suite failed on branch "${suite.head_branch ?? '?'}" in ${repo}.`,
        correlation: {
          branch: suite.head_branch ?? null,
          prNumber: suite.pull_requests?.[0]?.number ?? null,
        },
      };
    }
    return null;
  }
  if (eventType === 'pull_request_review') {
    if (body.action !== 'submitted') return null;
    const review = body.review;
    const state = (review?.state ?? '').toUpperCase();
    const hasBody = !!review?.body?.trim();
    if (state !== 'CHANGES_REQUESTED' && !hasBody) return null;
    const who = review?.user?.login ?? 'a reviewer';
    const reviewEventKind: EventKind =
      state === 'CHANGES_REQUESTED'
        ? 'review_changes_requested'
        : state === 'APPROVED'
          ? 'review_approved'
          : 'review_comment';
    return {
      severity: state === 'CHANGES_REQUESTED' ? 'critical' : 'warning',
      eventKind: reviewEventKind,
      body: `${who} ${state === 'CHANGES_REQUESTED' ? 'requested changes on' : 'reviewed'} PR #${body.pull_request?.number} in ${repo}.\n${review?.body ?? ''}\n${review?.html_url ?? ''}`.trim(),
      correlation: {
        branch: body.pull_request?.head?.ref ?? null,
        prNumber: body.pull_request?.number ?? null,
      },
    };
  }
  if (eventType === 'pull_request_review_comment') {
    if (body.action !== 'created') return null;
    const who = body.comment?.user?.login ?? 'a reviewer';
    return {
      severity: 'warning',
      eventKind: 'review_comment',
      body: `${who} left a review comment on PR #${body.pull_request?.number} in ${repo}.\n${body.comment?.body ?? ''}\n${body.comment?.html_url ?? ''}`.trim(),
      correlation: {
        branch: body.pull_request?.head?.ref ?? null,
        prNumber: body.pull_request?.number ?? null,
      },
    };
  }
  if (eventType === 'issue_comment') {
    if (body.action !== 'created' || !body.issue?.pull_request) return null;
    const who = body.comment?.user?.login ?? 'someone';
    return {
      severity: 'warning',
      eventKind: 'review_comment',
      body: `${who} commented on PR #${body.issue?.number} in ${repo}.\n${body.comment?.body ?? ''}\n${body.comment?.html_url ?? ''}`.trim(),
      correlation: { prNumber: body.issue?.number ?? null },
    };
  }
  return null;
}

export type RearmTarget = {
  orgId: string;
  repoId: string;
  prNumber: number | null;
  branch: string | null;
};

function parseRearmDelta(
  eventType: string,
  route: { orgId: string; repoId: string },
  body: GithubWebhookBody,
): RearmTarget | null {
  if (eventType !== 'pull_request_review') return null;
  if (body.action !== 'submitted' && body.action !== 'dismissed') return null;
  const prNumber = body.pull_request?.number;
  if (prNumber == null) return null;
  return {
    orgId: route.orgId,
    repoId: route.repoId,
    prNumber,
    branch: body.pull_request?.head?.ref ?? null,
  };
}

function parseCiDelta(
  eventType: string,
  route: { orgId: string; repoId: string },
  body: GithubWebhookBody,
): CiSyncDelta | null {
  if (eventType !== 'workflow_run' && eventType !== 'check_run' && eventType !== 'check_suite')
    return null;
  const prNumber =
    body.workflow_run?.pull_requests?.[0]?.number ??
    body.check_run?.pull_requests?.[0]?.number ??
    body.check_suite?.pull_requests?.[0]?.number ??
    null;
  const branch =
    body.workflow_run?.head_branch ??
    (body.check_run ? checkRunBranch(body.check_run) : null) ??
    body.check_suite?.head_branch ??
    null;
  return { orgId: route.orgId, repoId: route.repoId, prNumber, branch };
}

function checkRunBranch(check: NonNullable<GithubWebhookBody['check_run']>): string | null {
  return check.check_suite?.head_branch ?? check.pull_requests?.[0]?.head?.ref ?? null;
}

function deriveDedupeKey(
  eventType: string,
  body: GithubWebhookBody,
  deliveryId: string | undefined,
): string {
  const ciSha =
    body.workflow_run?.head_sha ?? body.check_run?.head_sha ?? body.check_suite?.head_sha;
  if (ciSha) return `ci:${ciSha}`;
  const groupId =
    body.workflow_run?.id ??
    body.check_run?.id ??
    body.check_suite?.id ??
    body.review?.id ??
    body.comment?.id;
  if (groupId !== undefined && groupId !== null) return `${eventType}:${groupId}`;
  return `delivery:${deliveryId ?? 'unknown'}`;
}
