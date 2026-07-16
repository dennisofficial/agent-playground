import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CiSyncDelta,
  EventKind,
  EventSeverity,
  IngressResult,
  NotificationSource,
  ParsedEvent,
  PrStateDelta,
  RawNotification,
} from '../domain';
import { ProjectRoutingService } from '../stimulus';

/**
 * The GitHub `NotificationSource` adapter — one of the MVP gateways. It owns the GitHub-specific:
 *
 *  - VERIFICATION: `X-Hub-Signature-256` HMAC-SHA256 of the EXACT request bytes against
 *    `GITHUB_WEBHOOK_SECRET` (constant-time compare). No secret configured / no header → the
 *    request is `unverifiable` (we never trust an unsigned GitHub payload).
 *  - PARSING: reads the `X-GitHub-Event` type + the JSON body's `repository.full_name`. MVP handles
 *    the event types that map to actionable work — `workflow_run` (CI failures), `check_run`/
 *    `check_suite` (failed checks). A `ping` is `ignored` (a successful no-op). Other types are
 *    `ignored` too (drop-in later).
 *  - DEDUPE: a stable `dedupeKey` from the gateway's grouping id (the workflow/check run id), NOT the
 *    per-delivery `X-GitHub-Delivery` (redeliveries of the SAME failure must collapse). Falls back to
 *    the delivery id when no run id is present.
 *  - SEVERITY: failed CI / checks → 'critical'; other actionable states → 'warning'.
 *  - ROUTING: `repository.full_name` (owner/repo) → `ProjectRoutingService.routeGithubRepo` →
 *    `repos` → its 1:1 channel. Unknown repo → `unroutable`.
 *
 * Output is ONLY a `ParsedEvent` (→ `EventStimulus`, `trust:'untrusted'`); everything downstream
 * (filter, seed, triage) is gateway-agnostic. Zero v1 imports — the HMAC shape is rewritten from v1's
 * Slack guard, not imported.
 */
@Injectable()
export class GithubNotificationSource implements NotificationSource {
  readonly source = 'github';
  private readonly logger = new Logger(GithubNotificationSource.name);

  constructor(
    private readonly env: EnvService,
    private readonly routing: ProjectRoutingService,
  ) {}

  /**
   * `/webhooks/github/events` front door — WORK-EVENTS intake ONLY. Verifies + routes the request, then
   * summarizes it into a triage stimulus (routed to the owning job by `StimulusIntake`). `pull_request`
   * is deliberately not actionable here (`summarizeGithubEvent` returns null for it) — that event drives
   * the silent PR-state sync via `handlePrWebhook` instead, never this method.
   */
  async handle(raw: RawNotification): Promise<IngressResult> {
    const g = await this.verifyAndRoute(raw);
    if ('outcome' in g) return g;
    return this.buildTriage(g, raw);
  }

  /**
   * The same work-events front door as `handle`, but also correlates the payload into a `CiSyncDelta`
   * for the silent CI-status sync (`ci`, non-null ONLY for the three CI event types) and a re-arm target
   * for the reconciler (`rearm`, non-null ONLY for a submitted/dismissed `pull_request_review` — a
   * required-review approval or dismissal can flip a PR's mergeability). All three are computed from the
   * SAME verified/routed payload so they can never disagree.
   */
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

  /** Build the work-events triage result from an already verified+routed payload. */
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
      // A verified payload we deliberately don't act on (e.g. a successful run, a push event, a
      // pull_request — that one's routed via `handlePrWebhook` instead).
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
      dedupeKey: deriveDedupeKey(
        g.eventType,
        g.body,
        raw.headers['x-github-delivery'],
      ),
      severity: summary.severity,
      eventKind: summary.eventKind,
      body: summary.body,
      ...(summary.correlation ? { correlation: summary.correlation } : {}),
    };
    return { outcome: 'accepted', event };
  }

  /**
   * `/webhooks/github/state` front door — silent PR-state sync ONLY. Verifies + routes the request same as
   * `handle`, but only ever parses `pull_request` events into a `PrStateDelta`; every other verified
   * event type is ignored (this endpoint never feeds `StimulusIntake`).
   */
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

  /**
   * Shared verify + route: HMAC-secret check, signature check, `ping` ignore, `repository.full_name`
   * read, `ProjectRoutingService.routeGithubRepo`. Both front doors call this so verification/routing
   * behavior can never drift between them.
   */
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

    // A GitHub payload carries no Slack team id — the repo IS the tenant key. Route across all
    // registered projects; the matched project carries its own org_id (multi-tenant-ready, no
    // per-payload team). Unknown repo → unroutable (Atlas never works a repo it doesn't own).
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

  /**
   * Parse a `pull_request` webhook into a `PrStateDelta` (open/reopen/close lifecycle sync), a `pr-rearm`
   * (a mergeability-affecting action on an already-open PR — head push / draft↔ready), or ignore it.
   */
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

  /**
   * Parse a `push` webhook: only a push to the repo's DEFAULT branch is a base-move that can silently
   * conflict its open PRs (`ref === refs/heads/<default_branch>`). Emit `repo-push` for those (the state
   * door then marks the repo's open PRs due-now); ignore every other push (feature-branch pushes are the
   * PR's own head moving — GitHub recomputes + the ~45s cadence already catches those). Deletes
   * (`ref` gone / no default_branch) are ignored.
   */
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

/** The subset of a GitHub webhook body the adapter reads. */
interface GithubWebhookBody {
  action?: string;
  /** The `push` event's fully-qualified ref, e.g. `refs/heads/main` (default-branch pushes matter). */
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

/** A triage summary + the correlation hint that routes it to the owning job (branch/PR). */
interface EventSummary {
  severity: EventSeverity;
  eventKind: EventKind;
  body: string;
  correlation?: { branch?: string | null; prNumber?: number | null };
}

/** Verify GitHub's `sha256=<hex>` HMAC of the raw bytes, constant-time. */
export function verifyGithubSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Map a GitHub event to a triage summary + correlation hint, or null when it's not actionable. Acts on
 * FAILED CI / checks (the autonomous-fix path) AND — so an owning job's brain hears about its own PR —
 * review submissions / comments. The correlation hint (branch + PR number) routes each to the job that
 * owns it; a match that finds no owner falls through to seed-a-new-thread (external CI).
 */
function summarizeGithubEvent(
  eventType: string,
  body: GithubWebhookBody,
): EventSummary | null {
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
    // A submitted review: route CHANGES_REQUESTED (critical) + non-empty COMMENT/APPROVED so Atlas can
    // read the feedback on its own PR. Skip empty approvals (no body → nothing to act on).
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
    // Only PR comments (issues carry a `pull_request` field when they are PRs); skip plain-issue chatter.
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

/** A PR to mark due-now on `GitStateReconciler` — a webhook that can flip mergeability for ONE PR. */
export type RearmTarget = {
  orgId: string;
  repoId: string;
  prNumber: number | null;
  branch: string | null;
};

/**
 * Re-arm target for a submitted/dismissed `pull_request_review` — a required-review approval or dismissal
 * can flip a PR's `mergeable_state` (`blocked` ↔ `clean`) with no other webhook signalling it. Non-null
 * ONLY for those two review actions, and only when the review's PR number is present.
 */
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

/**
 * Correlation delta for the silent CI-status sync — non-null ONLY for the three CI event types. We do
 * NOT gate on conclusion/status: recompute on ANY CI event (queued/in_progress included) so "running" is
 * caught, not only terminal states. Carries only correlation keys (never the webhook's own head_sha).
 */
function parseCiDelta(
  eventType: string,
  route: { orgId: string; repoId: string },
  body: GithubWebhookBody,
): CiSyncDelta | null {
  if (
    eventType !== 'workflow_run' &&
    eventType !== 'check_run' &&
    eventType !== 'check_suite'
  )
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

function checkRunBranch(
  check: NonNullable<GithubWebhookBody['check_run']>,
): string | null {
  return (
    check.check_suite?.head_branch ??
    check.pull_requests?.[0]?.head?.ref ??
    null
  );
}

/**
 * Derive the collapse key so ONE logical failure = one job, not one-per-webhook.
 *
 * CI events fan out: a single failing commit emits `workflow_run` + `check_suite` + N×`check_run`,
 * all sharing a `head_sha`. Keying CI events on `ci:<head_sha>` (NOT the per-event-type run id) folds
 * that whole fan-out — and any re-run/redelivery on the same commit — onto a single seeded/attached
 * job. Without this, each event type dedupes only against itself and seeds its own job.
 *
 * Non-CI events (review/comment) stay keyed on their unique per-item id (one message per review or
 * comment). Fall back to the per-item id (fixing the old `check_suite.conclusion` key, which carried
 * no run identity), then the per-delivery id, when no `head_sha` is present.
 */
function deriveDedupeKey(
  eventType: string,
  body: GithubWebhookBody,
  deliveryId: string | undefined,
): string {
  const ciSha =
    body.workflow_run?.head_sha ??
    body.check_run?.head_sha ??
    body.check_suite?.head_sha;
  if (ciSha) return `ci:${ciSha}`;
  const groupId =
    body.workflow_run?.id ??
    body.check_run?.id ??
    body.check_suite?.id ??
    body.review?.id ??
    body.comment?.id;
  if (groupId !== undefined && groupId !== null)
    return `${eventType}:${groupId}`;
  return `delivery:${deliveryId ?? 'unknown'}`;
}
