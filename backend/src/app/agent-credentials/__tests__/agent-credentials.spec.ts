import { EAgentProvider } from '@workspace/shared';
import { describe, expect, it } from 'vitest';
import { projectAgentCredentialView } from '../agent-credential.view';
import {
  buildAuthorizeUrl,
  exchangeCode,
  parseTokenSet,
  tokenSetToBlob,
} from '../oauth/claude-oauth.client';
import { assertValidCodexAuthJson, CodexAuthInvalidError } from '../oauth/codex-auth-validate';
import { decodeCodexAccountEmail } from '../oauth/codex-id-token';
import { buildAuthJson } from '../oauth/codex-oauth.client';
import { isNewerMaterial } from '../oauth/material-freshness';
import {
  parseModelWindows,
  parseUsageResponse,
  resetEpochToIso,
  toPercentUtilization,
} from '../usage/usage-parse';

/** Build a fake JWT (header.payload.sig) from claims — only the payload segment is read. */
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

describe('claude-oauth.client', () => {
  it('buildAuthorizeUrl carries PKCE challenge, state, S256 and manual code mode', () => {
    const url = new URL(buildAuthorizeUrl({ challenge: 'CHAL', state: 'ST' }));
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('ST');
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchangeCode rejects a pasted code whose #state fragment mismatches', async () => {
    await expect(
      exchangeCode({ code: 'abc#WRONG', verifier: 'v', state: 'RIGHT' }),
    ).rejects.toThrow(/state mismatch/);
  });

  it('parseTokenSet + tokenSetToBlob produce a .credentials.json-shaped blob', () => {
    const ts = parseTokenSet({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      scope: 'a b',
      account: { subscription_type: 'max', email_address: 'x@y.com' },
    });
    expect(ts.accountEmail).toBe('x@y.com');
    expect(ts.subscriptionType).toBe('max');
    const blob = tokenSetToBlob(ts);
    expect(blob.claudeAiOauth.accessToken).toBe('AT');
    expect(blob.claudeAiOauth.scopes).toEqual(['a', 'b']);
    expect(blob.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('codex auth', () => {
  it('buildAuthJson embeds tokens + account_id from the id_token + last_refresh', () => {
    const idToken = fakeJwt({
      email: 'me@openai.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123', chatgpt_plan_type: 'pro' },
    });
    const json = buildAuthJson(
      { idToken, accessToken: 'AT', refreshToken: 'RT' },
      '2026-07-18T00:00:00.000Z',
    );
    const parsed = JSON.parse(json);
    expect(parsed.tokens.account_id).toBe('acc_123');
    expect(parsed.tokens.refresh_token).toBe('RT');
    expect(parsed.last_refresh).toBe('2026-07-18T00:00:00.000Z');
    expect(parsed.auth_mode).toBe('chatgpt');
    expect(decodeCodexAccountEmail(json)).toBe('me@openai.com');
  });

  it('assertValidCodexAuthJson accepts full tokens and api-key-only, rejects incomplete', () => {
    expect(() =>
      assertValidCodexAuthJson({
        tokens: { id_token: 'a', access_token: 'b', refresh_token: 'c' },
      }),
    ).not.toThrow();
    expect(() => assertValidCodexAuthJson({ OPENAI_API_KEY: 'sk-x' })).not.toThrow();
    expect(() => assertValidCodexAuthJson({ tokens: { id_token: 'a' } })).toThrow(
      CodexAuthInvalidError,
    );
    expect(() => assertValidCodexAuthJson(null)).toThrow(CodexAuthInvalidError);
  });
});

describe('usage-parse', () => {
  it('toPercentUtilization normalizes fractions and percents into 0–100 ints', () => {
    expect(toPercentUtilization(0.5)).toBe(50);
    expect(toPercentUtilization(73)).toBe(73);
    expect(toPercentUtilization(2)).toBe(2);
    expect(toPercentUtilization(undefined)).toBeUndefined();
  });

  it('resetEpochToIso handles seconds and milliseconds', () => {
    expect(resetEpochToIso(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(resetEpochToIso(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(resetEpochToIso(undefined)).toBeUndefined();
  });

  it('parseUsageResponse pulls flat windows and weekly_scoped model caps', () => {
    const parsed = parseUsageResponse({
      five_hour: { utilization: 40, resets_at: '2026-07-18T05:00:00Z' },
      seven_day: { utilization: 12, resets_at: '2026-07-25T00:00:00Z' },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 88,
          resets_at: '2026-07-25T00:00:00Z',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    });
    expect(parsed.windows.fiveHour?.utilization).toBe(40);
    expect(parsed.windows.sevenDay?.utilization).toBe(12);
    expect(parsed.modelWindows).toEqual([
      { label: 'Fable', utilization: 88, resetsAt: '2026-07-25T00:00:00Z' },
    ]);
  });

  it('parseModelWindows ignores non-weekly_scoped and unlabeled entries', () => {
    expect(parseModelWindows({ limits: [{ kind: 'other', percent: 5 }] })).toEqual([]);
  });
});

describe('material-freshness', () => {
  it('claude compares claudeAiOauth.expiresAt', () => {
    const older = JSON.stringify({ claudeAiOauth: { expiresAt: 1000 } });
    const newer = JSON.stringify({ claudeAiOauth: { expiresAt: 2000 } });
    expect(isNewerMaterial(EAgentProvider.CLAUDE, newer, older)).toBe(true);
    expect(isNewerMaterial(EAgentProvider.CLAUDE, older, newer)).toBe(false);
  });

  it('codex compares last_refresh', () => {
    const older = JSON.stringify({ last_refresh: '2026-07-01T00:00:00Z' });
    const newer = JSON.stringify({ last_refresh: '2026-07-10T00:00:00Z' });
    expect(isNewerMaterial(EAgentProvider.CODEX, newer, older)).toBe(true);
    expect(isNewerMaterial(EAgentProvider.CODEX, older, newer)).toBe(false);
  });
});

describe('projectAgentCredentialView', () => {
  const base = {
    id: 'id1',
    provider: EAgentProvider.CLAUDE,
    kind: 'personal' as never,
    label: 'me@x.com',
    accountEmail: 'me@x.com',
    subscriptionType: 'max',
    status: 'active' as never,
    selected: true,
    expiresAt: new Date('2026-07-18T00:00:00Z'),
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };

  it('never leaks material and formats the plan label', () => {
    const view = projectAgentCredentialView({ ...base, usageSnapshot: null });
    expect(view).not.toHaveProperty('materialEnc');
    expect(view.plan).toBe('Max plan');
    expect(view.usage).toBeNull();
    expect(view.expiresAt).toBe('2026-07-18T00:00:00.000Z');
  });

  it('drops usage windows past their reset and flips ok=false when nothing is live', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const live = projectAgentCredentialView({
      ...base,
      usageSnapshot: {
        windows: { fiveHour: { utilization: 20, resetsAt: future } },
        fetchedAt: Date.now(),
        source: 'usage_api',
      },
    });
    expect(live.usage?.ok).toBe(true);
    expect(live.usage?.fiveHour?.utilization).toBe(20);

    const stale = projectAgentCredentialView({
      ...base,
      usageSnapshot: {
        windows: { fiveHour: { utilization: 20, resetsAt: past } },
        fetchedAt: Date.now(),
        source: 'usage_api',
      },
    });
    expect(stale.usage?.ok).toBe(false);
    expect(stale.usage?.source).toBe('stale');
    expect(stale.usage?.fiveHour).toBeNull();
  });
});
