import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { ProjectRoute, ProjectRoutingService } from '../stimulus';
import {
  GenericWebhookNotificationSource,
  constantTimeEqual,
} from './generic-webhook-notification.source';
import type { RawNotification } from '../domain';

const SECRET = 'shared-webhook-secret';

function fakeEnv(overrides: Record<string, unknown> = {}): EnvService {
  const map: Record<string, unknown> = { ATLAS_WEBHOOK_SECRET: SECRET, ...overrides };
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

const ROUTE: ProjectRoute = {
  orgId: 'T1',
  repoId: 'web',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channel: { id: 'chan-1' } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  project: {} as any,
};

function fakeRouting(route: ProjectRoute | null): ProjectRoutingService {
  return {
    routeProjectId: async (orgId: string, repoId: string) =>
      route && route.orgId === orgId && route.repoId === repoId ? route : null,
  } as unknown as ProjectRoutingService;
}

function raw(body: unknown, headers: Record<string, string | undefined>): RawNotification {
  return { rawBody: Buffer.from(JSON.stringify(body)), headers, body };
}

describe('constantTimeEqual', () => {
  it('true for equal strings, false otherwise (incl. length mismatch, no throw)', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('GenericWebhookNotificationSource.handle', () => {
  const body = { orgId: 'T1', repoId: 'web', title: 'DB down', body: 'connection refused', severity: 'critical' };

  it('rejects when no secret configured (unverifiable)', async () => {
    const src = new GenericWebhookNotificationSource(fakeEnv({ ATLAS_WEBHOOK_SECRET: undefined }), fakeRouting(ROUTE));
    const res = await src.handle(raw(body, { 'x-atlas-webhook-secret': SECRET }));
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unverifiable' });
  });

  it('rejects a missing secret header (unverifiable)', async () => {
    const src = new GenericWebhookNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const res = await src.handle(raw(body, {}));
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unverifiable' });
  });

  it('rejects a wrong secret (bad-signature)', async () => {
    const src = new GenericWebhookNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const res = await src.handle(raw(body, { 'x-atlas-webhook-secret': 'nope' }));
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'bad-signature' });
  });

  it('rejects a payload missing required fields (malformed)', async () => {
    const src = new GenericWebhookNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const res = await src.handle(raw({ orgId: 'T1' }, { 'x-atlas-webhook-secret': SECRET }));
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'malformed' });
  });

  it('rejects an unroutable project (unroutable)', async () => {
    const src = new GenericWebhookNotificationSource(fakeEnv(), fakeRouting(null));
    const res = await src.handle(raw(body, { 'x-atlas-webhook-secret': SECRET }));
    expect(res).toMatchObject({ outcome: 'rejected', reason: 'unroutable' });
  });

  it('maps a verified payload → accepted EventStimulus (caller severity, content-hash dedupeKey)', async () => {
    const src = new GenericWebhookNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const res = await src.handle(raw(body, { 'x-atlas-webhook-secret': SECRET }));
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event).toMatchObject({ orgId: 'T1', repoId: 'web', source: 'webhook', severity: 'critical' });
    expect(res.event.body).toContain('DB down');
    expect(res.event.body).toContain('connection refused');
    expect(res.event.dedupeKey).toBeTruthy();
  });

  it('honors a caller-supplied dedupeKey + source', async () => {
    const src = new GenericWebhookNotificationSource(fakeEnv(), fakeRouting(ROUTE));
    const withKey = { ...body, dedupeKey: 'issue-42', source: 'posthog' };
    const res = await src.handle(raw(withKey, { 'x-atlas-webhook-secret': SECRET }));
    if (res.outcome !== 'accepted') throw new Error('expected accepted');
    expect(res.event.dedupeKey).toBe('issue-42');
    expect(res.event.source).toBe('posthog');
  });
});
