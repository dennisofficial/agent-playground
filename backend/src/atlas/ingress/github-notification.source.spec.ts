import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { ProjectRoute, ProjectRoutingService } from '../stimulus';
import {
  GithubNotificationSource,
  verifyGithubSignature,
} from './github-notification.source';
import type { RawNotification } from '../domain';

const SECRET = 'gh-webhook-secret';

function fakeEnv(overrides: Record<string, unknown> = {}): EnvService {
  const map: Record<string, unknown> = {
    ATLAS_GITHUB_WEBHOOK_SECRET: SECRET,
    ...overrides,
  };
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

const ROUTE: ProjectRoute = {
  teamId: 'T1',
  projectId: 'web',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channel: { id: 'chan-1' } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  project: { team_id: 'T1', project_id: 'web', git_url: 'https://github.com/acme/web.git' } as any,
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
    workflow_run: { id: 99, name: 'CI', status: 'completed', conclusion: 'failure', html_url: 'http://x' },
  };

  it('rejects when no webhook secret is configured (unverifiable)', async () => {
    const src = new GithubNotificationSource(fakeEnv({ ATLAS_GITHUB_WEBHOOK_SECRET: undefined }), fakeRouting(ROUTE));
    const json = JSON.stringify(failedWorkflow);
    const res = await src.handle(raw(failedWorkflow, { 'x-hub-signature-256': sign(json), 'x-github-event': 'workflow_run' }));
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
      raw(failedWorkflow, { 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-event': 'workflow_run' }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'bad-signature' });
  });

  it('ignores a verified ping (successful no-op)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const ping = { repository: { full_name: 'Acme/Web' }, zen: 'go' };
    const json = JSON.stringify(ping);
    const res = await src.handle(raw(ping, { 'x-hub-signature-256': sign(json), 'x-github-event': 'ping' }));
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
      teamId: 'T1',
      projectId: 'web',
      source: 'github',
      severity: 'critical',
      dedupeKey: 'workflow_run:99',
    });
    expect(res.event.body).toContain('CI');
    expect(res.event.body).toContain('failure');
  });

  it('rejects an unroutable repo (no atlas_project)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(null));
    const json = JSON.stringify(failedWorkflow);
    const res = await src.handle(
      raw(failedWorkflow, { 'x-hub-signature-256': sign(json), 'x-github-event': 'workflow_run' }),
    );
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unroutable' });
  });

  it('ignores a verified SUCCESSFUL workflow_run (no action)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const ok = {
      repository: { full_name: 'Acme/Web' },
      workflow_run: { id: 99, name: 'CI', status: 'completed', conclusion: 'success' },
    };
    const json = JSON.stringify(ok);
    const res = await src.handle(raw(ok, { 'x-hub-signature-256': sign(json), 'x-github-event': 'workflow_run' }));
    expect(res).toMatchObject({ outcome: 'ignored' });
  });

  it('rejects a payload missing repository.full_name (malformed)', async () => {
    const src = new GithubNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const bad = { workflow_run: { id: 1, status: 'completed', conclusion: 'failure' } };
    const json = JSON.stringify(bad);
    const res = await src.handle(raw(bad, { 'x-hub-signature-256': sign(json), 'x-github-event': 'workflow_run' }));
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'malformed' });
  });
});
