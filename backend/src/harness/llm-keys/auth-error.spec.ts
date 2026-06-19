import { describe, expect, it } from 'vitest';
import { isAuthError } from './auth-error';

describe('isAuthError', () => {
  it('matches auth/credential failure markers', () => {
    for (const msg of [
      'Request failed with status code 401',
      'Error: Unauthorized',
      "authentication_error: invalid x-api-key",
      'Incorrect API key provided: sk-ant-***',
      'invalid_api_key',
      'OAuth token expired',
      'your credential was revoked',
      '403 Forbidden',
      'Claude worker ended: error_during_execution (invalid bearer token)',
    ]) {
      expect(isAuthError(msg), msg).toBe(true);
    }
  });

  it('does NOT match rate-limit / overload / generic errors', () => {
    for (const msg of [
      'Request failed with status code 429',
      'rate_limit_error: too many requests',
      'Overloaded',
      'quota exceeded for this month',
      'ECONNRESET',
      'the model returned no output',
      'git merge conflict in src/foo.ts',
      undefined,
      null,
      '',
    ]) {
      expect(isAuthError(msg), String(msg)).toBe(false);
    }
  });

  it('treats a 429 that mentions "token" as NOT auth (rate-limit wins)', () => {
    expect(isAuthError('429 too many requests — token bucket empty')).toBe(
      false,
    );
  });
});
