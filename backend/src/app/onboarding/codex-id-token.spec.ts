import { describe, expect, it } from 'vitest';
import { decodeCodexAccountEmail } from './codex-id-token';

function fakeAuthJson(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return JSON.stringify({ tokens: { id_token: `${header}.${payload}.sig` } });
}

describe('decodeCodexAccountEmail', () => {
  it('returns the top-level email claim', () => {
    expect(
      decodeCodexAccountEmail(fakeAuthJson({ email: 'a@example.com' })),
    ).toBe('a@example.com');
  });

  it('falls back to the openai profile email claim when no top-level email is present', () => {
    const authJson = fakeAuthJson({
      'https://api.openai.com/profile': { email: 'x@y.com' },
    });
    expect(decodeCodexAccountEmail(authJson)).toBe('x@y.com');
  });

  it('returns undefined for an API-key-only blob (no tokens / no id_token)', () => {
    expect(
      decodeCodexAccountEmail(JSON.stringify({ apiKey: 'sk-123' })),
    ).toBeUndefined();
  });

  it('returns undefined for a garbage / non-JSON string', () => {
    expect(decodeCodexAccountEmail('not json at all')).toBeUndefined();
  });

  it('returns undefined when the id_token is present but the email claim is empty', () => {
    expect(
      decodeCodexAccountEmail(fakeAuthJson({ email: '' })),
    ).toBeUndefined();
  });

  it('trims the email claim and returns undefined when it is only whitespace', () => {
    expect(
      decodeCodexAccountEmail(fakeAuthJson({ email: '  a@example.com  ' })),
    ).toBe('a@example.com');
    expect(
      decodeCodexAccountEmail(fakeAuthJson({ email: '   ' })),
    ).toBeUndefined();
  });
});
