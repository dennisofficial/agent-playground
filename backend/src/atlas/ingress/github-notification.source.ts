import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  EventSeverity,
  IngressResult,
  NotificationSource,
  ParsedEvent,
  RawNotification,
} from '../domain';
import { ProjectRoutingService } from '../stimulus';

/**
 * The GitHub `NotificationSource` adapter — one of the MVP gateways. It owns the GitHub-specific:
 *
 *  - VERIFICATION: `X-Hub-Signature-256` HMAC-SHA256 of the EXACT request bytes against
 *    `ATLAS_GITHUB_WEBHOOK_SECRET` (constant-time compare). No secret configured / no header → the
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
 *    `atlas_projects` → its 1:1 channel. Unknown repo → `unroutable`.
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

  async handle(raw: RawNotification): Promise<IngressResult> {
    const secret = this.env.get('ATLAS_GITHUB_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.warn('ATLAS_GITHUB_WEBHOOK_SECRET unset — refusing GitHub webhook');
      return { outcome: 'rejected', reason: 'unverifiable', detail: 'no webhook secret configured' };
    }

    const signature = raw.headers['x-hub-signature-256'];
    if (!signature) {
      return { outcome: 'rejected', reason: 'unverifiable', detail: 'missing X-Hub-Signature-256' };
    }
    if (!verifyGithubSignature(raw.rawBody, signature, secret)) {
      return { outcome: 'rejected', reason: 'bad-signature', detail: 'X-Hub-Signature-256 mismatch' };
    }

    const eventType = raw.headers['x-github-event'] ?? 'unknown';
    if (eventType === 'ping') {
      return { outcome: 'ignored', reason: 'unsupported', detail: 'github ping' };
    }

    const body = raw.body as GithubWebhookBody;
    const repo = body?.repository?.full_name;
    if (!repo) {
      return { outcome: 'rejected', reason: 'malformed', detail: 'missing repository.full_name' };
    }

    // A GitHub payload carries no Slack team id — the repo IS the tenant key. Route across all
    // registered projects; the matched project carries its own org_id (multi-tenant-ready, no
    // per-payload team). Unknown repo → unroutable (Atlas never works a repo it doesn't own).
    const route = await this.routing.routeGithubRepo(repo);
    if (!route) {
      return { outcome: 'rejected', reason: 'unroutable', detail: `no atlas_project for repo ${repo}` };
    }

    const summary = summarizeGithubEvent(eventType, body);
    if (!summary) {
      // A verified payload we deliberately don't act on (e.g. a successful run, a push event).
      return { outcome: 'ignored', reason: 'unsupported', detail: `github ${eventType} (no action)` };
    }

    const event: ParsedEvent = {
      orgId: route.orgId,
      repoId: route.repoId,
      source: this.source,
      dedupeKey: deriveDedupeKey(eventType, body, raw.headers['x-github-delivery']),
      severity: summary.severity,
      body: summary.body,
    };
    return { outcome: 'accepted', event };
  }
}

/** The subset of a GitHub webhook body the adapter reads. */
interface GithubWebhookBody {
  action?: string;
  repository?: { full_name?: string };
  workflow_run?: { id?: number; name?: string; conclusion?: string; status?: string; html_url?: string };
  check_run?: { id?: number; name?: string; conclusion?: string; status?: string; html_url?: string };
  check_suite?: { id?: number; conclusion?: string; status?: string; head_branch?: string };
}

/** Verify GitHub's `sha256=<hex>` HMAC of the raw bytes, constant-time. */
export function verifyGithubSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Map a GitHub event to a triage summary, or null when it's not actionable. MVP acts on FAILED CI /
 * checks — the autonomous-fix path's bread and butter.
 */
function summarizeGithubEvent(
  eventType: string,
  body: GithubWebhookBody,
): { severity: EventSeverity; body: string } | null {
  if (eventType === 'workflow_run') {
    const run = body.workflow_run;
    if (run?.status !== 'completed') return null;
    if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
      return {
        severity: 'critical',
        body: `GitHub Actions workflow "${run.name ?? 'unknown'}" ${run.conclusion} in ${body.repository?.full_name}.\n${run.html_url ?? ''}`.trim(),
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
        body: `GitHub check "${check.name ?? 'unknown'}" ${check.conclusion} in ${body.repository?.full_name}.\n${check.html_url ?? ''}`.trim(),
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
        body: `GitHub check suite failed on branch "${suite.head_branch ?? '?'}" in ${body.repository?.full_name}.`,
      };
    }
    return null;
  }
  return null;
}

/**
 * Derive the collapse key. Prefer the gateway's grouping id (run id) so REDELIVERIES of the same
 * failure dedupe; fall back to the per-delivery id when none is present (still unique-per-event).
 */
function deriveDedupeKey(
  eventType: string,
  body: GithubWebhookBody,
  deliveryId: string | undefined,
): string {
  const runId =
    body.workflow_run?.id ?? body.check_run?.id ?? body.check_suite?.conclusion;
  if (runId !== undefined && runId !== null) return `${eventType}:${runId}`;
  return `delivery:${deliveryId ?? 'unknown'}`;
}
