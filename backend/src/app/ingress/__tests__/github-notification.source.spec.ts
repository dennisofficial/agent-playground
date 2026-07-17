import type { EnvService } from '@core/config/env/env.service';
import type { CiSyncDelta, RawNotification } from '@shared/domain';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GithubNotificationSource, verifyGithubSignature } from '../github-notification.source';
import type { ProjectRoute, ProjectRoutingService } from '../stimulus';

const SECRET = 'gh-webhook-secret';

function fakeEnv(overrides: Record<string, unknown> = {}): EnvService {
  const map: Record<string, unknown> = {
    GITHUB_WEBHOOK_SECRET: SECRET,
    ...overrides,
  };
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

const ROUTE: ProjectRoute = {
  orgId: 'T1',
  repoId: 'web',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repo: {
    org_id: 'T1',
    repo_id: 'web',
    git_url: 'https://github.com/acme/web.git',
  } as any,
};

function fakeRouting(route: ProjectRoute | null): ProjectRoutingService {
  return {
    routeGithubRepo: async () => route,
    routeProjectId: async () => route,
  } as unknown as ProjectRoutingService;
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
}

function raw(body: unknown, headers: Record<string, string | undefined>): RawNotification {
  const json = JSON.stringify(body);
  return { rawBody: Buffer.from(json), headers, body };
}

describe('verifyGithubSignature', () => {
  it('accepts a correct sha256 HMAC of the raw bytes', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyGithubSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ a: 1 });
    const sig = sign(body);
    expect(verifyGithubSignature(Buffer.from(body + 'x'), sig, SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyGithubSignature(Buffer.from(body), sign(body, 'wrong'), SECRET)).toBe(false);
  });

  it('rejects a malformed signature (length mismatch, no throw)', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyGithubSignature(Buffer.from(body), 'sha256=short', SECRET)).toBe(false);
  });
});

describe('GithubNotificationSource.handle', () => {
  const failedWorkflow = {
    repository: { full_name: 'Acme/Web' },
    workflow_run: {
      id: 99,
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'http://x',
    },
  };

  it('rejects when no webhook secret is configured (unverifiable)', async () => {
    const src = new GithubNotificationSource(
      fakeEnv({ GITHUB_WEBHOOK_SECRET: undefined }),
      fakeRouting(ROUTE),
    );
    const json = JSON.stringify(failedWorkflow);
    const res = await src.handle(
      raw(failedWorkflow, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'workflow_run',
      }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unverifiable' });
  });

  it('rejects a missing signature header (unverifiable)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const res = await src.handle(raw(failedWorkflow, { 'x-github-event': 'workflow_run' }));
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unverifiable' });
  });

  it('rejects a bad signature (bad-signature)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const res = await src.handle(
      raw(failedWorkflow, {
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-event': 'workflow_run',
      }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'bad-signature' });
  });

  it('ignores a verified ping (successful no-op)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const ping = { repository: { full_name: 'Acme/Web' }, zen: 'go' };
    const json = JSON.stringify(ping);
    const res = await src.handle(
      raw(ping, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'ping',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored', reason: 'unsupported' });
  });

  it('maps a verified failed workflow_run → accepted EventStimulus (critical, routed, dedupe on run id)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const json = JSON.stringify(failedWorkflow);
    const res = await src.handle(
      raw(failedWorkflow, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'workflow_run',
        'x-github-delivery': 'd-1',
      }),
    );
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event).toMatchObject({
      orgId: 'T1',
      repoId: 'web',
      source: 'github',
      severity: 'critical',
      eventKind: 'ci_failure',
      dedupeKey: 'workflow_run:99',
    });
    expect(res.event.body).toContain('CI');
    expect(res.event.body).toContain('failure');
  });

  it("collapses one commit's CI fan-out (workflow_run + check_suite + check_run) onto a single ci:<sha> key", async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const SHA = 'abc123def456';
    const events: Array<[string, unknown]> = [
      [
        'workflow_run',
        {
          repository: { full_name: 'Acme/Web' },
          workflow_run: {
            id: 99,
            name: 'CI',
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            head_sha: SHA,
          },
        },
      ],
      [
        'check_suite',
        {
          repository: { full_name: 'Acme/Web' },
          check_suite: {
            id: 5,
            status: 'completed',
            conclusion: 'failure',
            head_branch: 'main',
            head_sha: SHA,
          },
        },
      ],
      [
        'check_run',
        {
          repository: { full_name: 'Acme/Web' },
          check_run: {
            id: 7,
            name: 'Typecheck',
            status: 'completed',
            conclusion: 'failure',
            head_sha: SHA,
            check_suite: { head_branch: 'main' },
          },
        },
      ],
    ];
    for (const [eventType, body] of events) {
      const json = JSON.stringify(body);
      const res = await src.handle(
        raw(body, {
          'x-hub-signature-256': sign(json),
          'x-github-event': eventType,
        }),
      );
      expect(res.outcome).toBe('accepted');
      if (res.outcome !== 'accepted') throw new Error('expected accepted');
      // All three collapse to the SAME key so the intake seeds/attaches ONE job, not one per event type.
      expect(res.event.dedupeKey).toBe(`ci:${SHA}`);
    }
  });

  it('falls back to check_suite.id (not conclusion) when a check_suite carries no head_sha', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const body = {
      repository: { full_name: 'Acme/Web' },
      check_suite: {
        id: 42,
        status: 'completed',
        conclusion: 'failure',
        head_branch: 'main',
      },
    };
    const json = JSON.stringify(body);
    const res = await src.handle(
      raw(body, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'check_suite',
      }),
    );
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event.dedupeKey).toBe('check_suite:42');
  });

  it('rejects an unroutable repo (no atlas_project)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(null));
    const json = JSON.stringify(failedWorkflow);
    const res = await src.handle(
      raw(failedWorkflow, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'workflow_run',
      }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unroutable' });
  });

  it('ignores a verified SUCCESSFUL workflow_run (no action)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const ok = {
      repository: { full_name: 'Acme/Web' },
      workflow_run: {
        id: 99,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
      },
    };
    const json = JSON.stringify(ok);
    const res = await src.handle(
      raw(ok, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'workflow_run',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored' });
  });

  it('rejects a payload missing repository.full_name (malformed)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const bad = {
      workflow_run: { id: 1, status: 'completed', conclusion: 'failure' },
    };
    const json = JSON.stringify(bad);
    const res = await src.handle(
      raw(bad, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'workflow_run',
      }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'malformed' });
  });

  it('emits a correlation hint (branch + PR) on a failed workflow_run so it routes to the owning job', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      repository: { full_name: 'Acme/Web' },
      workflow_run: {
        id: 7,
        name: 'CI',
        status: 'completed',
        conclusion: 'failure',
        head_branch: 'feat/a1b2c3d4',
        pull_requests: [{ number: 12 }],
      },
    };
    const json = JSON.stringify(payload);
    const res = await src.handle(
      raw(payload, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'workflow_run',
      }),
    );
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event.correlation).toEqual({
      branch: 'feat/a1b2c3d4',
      prNumber: 12,
    });
  });

  it('routes a pull_request_review CHANGES_REQUESTED → accepted (critical) with PR correlation', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'submitted',
      repository: { full_name: 'Acme/Web' },
      pull_request: { number: 5, head: { ref: 'feat/a1b2c3d4' } },
      review: {
        id: 900,
        state: 'changes_requested',
        body: 'fix the null check',
        user: { login: 'dennis' },
      },
    };
    const json = JSON.stringify(payload);
    const res = await src.handle(
      raw(payload, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request_review',
      }),
    );
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event).toMatchObject({
      severity: 'critical',
      eventKind: 'review_changes_requested',
      dedupeKey: 'pull_request_review:900',
    });
    expect(res.event.correlation).toEqual({
      branch: 'feat/a1b2c3d4',
      prNumber: 5,
    });
    expect(res.event.body).toContain('fix the null check');
  });

  it('routes an issue_comment on a PR → accepted with PR correlation', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'created',
      repository: { full_name: 'Acme/Web' },
      issue: { number: 8, pull_request: { url: 'http://pr' } },
      comment: { id: 111, body: 'can you rebase?', user: { login: 'dennis' } },
    };
    const json = JSON.stringify(payload);
    const res = await src.handle(
      raw(payload, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'issue_comment',
      }),
    );
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event.correlation).toEqual({ prNumber: 8 });
    expect(res.event.eventKind).toBe('review_comment');
  });

  it('routes a pull_request_review APPROVED with a body → accepted (review_approved)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'submitted',
      repository: { full_name: 'Acme/Web' },
      pull_request: { number: 5, head: { ref: 'feat/a1b2c3d4' } },
      review: {
        id: 902,
        state: 'approved',
        body: 'looks great, shipping',
        user: { login: 'dennis' },
      },
    };
    const json = JSON.stringify(payload);
    const res = await src.handle(
      raw(payload, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request_review',
      }),
    );
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event).toMatchObject({
      severity: 'warning',
      eventKind: 'review_approved',
    });
  });

  it('ignores an issue_comment on a plain issue (not a PR)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'created',
      repository: { full_name: 'Acme/Web' },
      issue: { number: 8 }, // no pull_request field → a real issue, not a PR
      comment: { id: 111, body: 'hi', user: { login: 'dennis' } },
    };
    const json = JSON.stringify(payload);
    const res = await src.handle(
      raw(payload, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'issue_comment',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored' });
  });

  it('ignores a pull_request event (no longer pr-sync) — that lives on handlePrWebhook', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'opened',
      repository: { full_name: 'Acme/Web' },
      pull_request: {
        number: 5,
        html_url: 'http://pr/5',
        merged: false,
        head: { ref: 'feat/x' },
      },
    };
    const json = JSON.stringify(payload);
    const res = await src.handle(
      raw(payload, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored', reason: 'unsupported' });
  });
});

describe('GithubNotificationSource.handlePrWebhook', () => {
  const openedPr = {
    action: 'opened',
    repository: { full_name: 'Acme/Web' },
    pull_request: {
      number: 5,
      html_url: 'http://pr/5',
      merged: false,
      head: { ref: 'feat/x' },
    },
  };

  it('rejects when no webhook secret is configured (unverifiable)', async () => {
    const src = new GithubNotificationSource(
      fakeEnv({ GITHUB_WEBHOOK_SECRET: undefined }),
      fakeRouting(ROUTE),
    );
    const json = JSON.stringify(openedPr);
    const res = await src.handlePrWebhook(
      raw(openedPr, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unverifiable' });
  });

  it('rejects a bad signature (bad-signature)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const res = await src.handlePrWebhook(
      raw(openedPr, {
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'bad-signature' });
  });

  it('rejects an unroutable repo (no atlas_project)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(null));
    const json = JSON.stringify(openedPr);
    const res = await src.handlePrWebhook(
      raw(openedPr, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unroutable' });
  });

  it('maps a verified pull_request opened → pr-sync delta', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const json = JSON.stringify(openedPr);
    const res = await src.handlePrWebhook(
      raw(openedPr, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({
      outcome: 'pr-sync',
      delta: {
        orgId: 'T1',
        repoId: 'web',
        action: 'opened',
        prNumber: 5,
        headRef: 'feat/x',
        url: 'http://pr/5',
        merged: false,
      },
    });
  });

  it('ignores a non-pull_request event type (not a pull_request event)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const workflow = {
      repository: { full_name: 'Acme/Web' },
      workflow_run: {
        id: 99,
        name: 'CI',
        status: 'completed',
        conclusion: 'failure',
      },
    };
    const json = JSON.stringify(workflow);
    const res = await src.handlePrWebhook(
      raw(workflow, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'workflow_run',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored', reason: 'unsupported' });
  });

  it('a synchronize (head push) re-arms the owning PR (pr-rearm)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const synced = {
      action: 'synchronize',
      repository: { full_name: 'Acme/Web' },
      pull_request: {
        number: 5,
        html_url: 'http://pr/5',
        merged: false,
        head: { ref: 'feat/x' },
      },
    };
    const json = JSON.stringify(synced);
    const res = await src.handlePrWebhook(
      raw(synced, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({
      outcome: 'pr-rearm',
      orgId: 'T1',
      repoId: 'web',
      prNumber: 5,
      branch: 'feat/x',
    });
  });

  it('a ready_for_review action re-arms the owning PR (pr-rearm)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const readied = {
      action: 'ready_for_review',
      repository: { full_name: 'Acme/Web' },
      pull_request: {
        number: 9,
        html_url: 'http://pr/9',
        merged: false,
        head: { ref: 'feat/y' },
      },
    };
    const json = JSON.stringify(readied);
    const res = await src.handlePrWebhook(
      raw(readied, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({
      outcome: 'pr-rearm',
      orgId: 'T1',
      repoId: 'web',
      prNumber: 9,
      branch: 'feat/y',
    });
  });

  it('a converted_to_draft action re-arms the owning PR (pr-rearm)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const drafted = {
      action: 'converted_to_draft',
      repository: { full_name: 'Acme/Web' },
      pull_request: {
        number: 11,
        html_url: 'http://pr/11',
        merged: false,
        head: { ref: 'feat/z' },
      },
    };
    const json = JSON.stringify(drafted);
    const res = await src.handlePrWebhook(
      raw(drafted, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({
      outcome: 'pr-rearm',
      orgId: 'T1',
      repoId: 'web',
      prNumber: 11,
      branch: 'feat/z',
    });
  });

  it('ignores an unactionable pull_request action (e.g. labeled)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const labeled = {
      action: 'labeled',
      repository: { full_name: 'Acme/Web' },
      pull_request: {
        number: 5,
        html_url: 'http://pr/5',
        merged: false,
        head: { ref: 'feat/x' },
      },
    };
    const json = JSON.stringify(labeled);
    const res = await src.handlePrWebhook(
      raw(labeled, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'pull_request',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored', reason: 'unsupported' });
  });

  it('maps a verified push to the DEFAULT branch → repo-push (marks the repo due)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const push = {
      ref: 'refs/heads/main',
      repository: { full_name: 'Acme/Web', default_branch: 'main' },
    };
    const json = JSON.stringify(push);
    const res = await src.handlePrWebhook(
      raw(push, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'push',
      }),
    );
    expect(res).toMatchObject({
      outcome: 'repo-push',
      orgId: 'T1',
      repoId: 'web',
    });
  });

  it('ignores a push to a NON-default branch (a feature head moving is caught by the PR cadence)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const push = {
      ref: 'refs/heads/feat/x',
      repository: { full_name: 'Acme/Web', default_branch: 'main' },
    };
    const json = JSON.stringify(push);
    const res = await src.handlePrWebhook(
      raw(push, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'push',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored', reason: 'unsupported' });
  });

  it("ignores a push with no default_branch in the payload (can't confirm it's the base)", async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const push = {
      ref: 'refs/heads/main',
      repository: { full_name: 'Acme/Web' },
    };
    const json = JSON.stringify(push);
    const res = await src.handlePrWebhook(
      raw(push, {
        'x-hub-signature-256': sign(json),
        'x-github-event': 'push',
      }),
    );
    expect(res).toMatchObject({ outcome: 'ignored', reason: 'unsupported' });
  });
});

describe('GithubNotificationSource.handleWorkEvent', () => {
  it('on a check_run payload returns a non-null CI delta AND the same triage as handle() on the same payload', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      repository: { full_name: 'Acme/Web' },
      check_run: {
        id: 7,
        name: 'Typecheck',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'http://x',
        check_suite: { head_branch: 'feat/a1b2c3d4' },
        pull_requests: [{ number: 12 }],
      },
    };
    const headers = {
      'x-hub-signature-256': sign(JSON.stringify(payload)),
      'x-github-event': 'check_run',
      'x-github-delivery': 'd-1',
    };

    const { triage, ci } = await src.handleWorkEvent(raw(payload, headers));
    const directTriage = await src.handle(raw(payload, headers));

    expect(triage).toEqual(directTriage);
    expect(ci).toEqual<CiSyncDelta>({
      orgId: 'T1',
      repoId: 'web',
      prNumber: 12,
      branch: 'feat/a1b2c3d4',
    });
  });

  it('falls back to check_run.pull_requests[0].head.ref when the suite branch is absent', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      repository: { full_name: 'Acme/Web' },
      check_run: {
        id: 8,
        name: 'Typecheck',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'http://x',
        pull_requests: [{ number: 13, head: { ref: 'feat/from-pr-head' } }],
      },
    };
    const headers = {
      'x-hub-signature-256': sign(JSON.stringify(payload)),
      'x-github-event': 'check_run',
      'x-github-delivery': 'd-2',
    };

    const { triage, ci } = await src.handleWorkEvent(raw(payload, headers));

    expect(ci).toEqual<CiSyncDelta>({
      orgId: 'T1',
      repoId: 'web',
      prNumber: 13,
      branch: 'feat/from-pr-head',
    });
    expect(triage).toMatchObject({
      outcome: 'accepted',
      event: { correlation: { branch: 'feat/from-pr-head', prNumber: 13 } },
    });
  });

  it('returns ci: null for a pull_request payload (not a CI event type)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'opened',
      repository: { full_name: 'Acme/Web' },
      pull_request: {
        number: 5,
        html_url: 'http://pr/5',
        merged: false,
        head: { ref: 'feat/x' },
      },
    };
    const headers = {
      'x-hub-signature-256': sign(JSON.stringify(payload)),
      'x-github-event': 'pull_request',
    };

    const { ci } = await src.handleWorkEvent(raw(payload, headers));
    expect(ci).toBeNull();
  });

  it('returns ci: null for a push payload (not a supported CI event type)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = { repository: { full_name: 'Acme/Web' } };
    const headers = {
      'x-hub-signature-256': sign(JSON.stringify(payload)),
      'x-github-event': 'push',
    };

    const { ci, triage } = await src.handleWorkEvent(raw(payload, headers));
    expect(ci).toBeNull();
    expect(triage).toMatchObject({ outcome: 'ignored' });
  });

  it('a submitted pull_request_review yields a non-null rearm for the owning PR', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'submitted',
      repository: { full_name: 'Acme/Web' },
      pull_request: { number: 5, head: { ref: 'feat/a1b2c3d4' } },
      review: {
        id: 900,
        state: 'approved',
        body: '',
        user: { login: 'dennis' },
      },
    };
    const headers = {
      'x-hub-signature-256': sign(JSON.stringify(payload)),
      'x-github-event': 'pull_request_review',
    };

    const { rearm } = await src.handleWorkEvent(raw(payload, headers));
    expect(rearm).toEqual({
      orgId: 'T1',
      repoId: 'web',
      prNumber: 5,
      branch: 'feat/a1b2c3d4',
    });
  });

  it('a dismissed pull_request_review also yields a non-null rearm', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      action: 'dismissed',
      repository: { full_name: 'Acme/Web' },
      pull_request: { number: 6, head: { ref: 'feat/b' } },
      review: {
        id: 901,
        state: 'dismissed',
        body: '',
        user: { login: 'dennis' },
      },
    };
    const headers = {
      'x-hub-signature-256': sign(JSON.stringify(payload)),
      'x-github-event': 'pull_request_review',
    };

    const { rearm } = await src.handleWorkEvent(raw(payload, headers));
    expect(rearm).toEqual({
      orgId: 'T1',
      repoId: 'web',
      prNumber: 6,
      branch: 'feat/b',
    });
  });

  it('returns rearm: null for a non-review work event (e.g. check_run)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const payload = {
      repository: { full_name: 'Acme/Web' },
      check_run: {
        id: 7,
        name: 'Typecheck',
        status: 'completed',
        conclusion: 'failure',
      },
    };
    const headers = {
      'x-hub-signature-256': sign(JSON.stringify(payload)),
      'x-github-event': 'check_run',
    };

    const { rearm } = await src.handleWorkEvent(raw(payload, headers));
    expect(rearm).toBeNull();
  });
});
