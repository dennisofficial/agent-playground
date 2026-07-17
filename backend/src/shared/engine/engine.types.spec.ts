import { describe, expect, it } from 'vitest';
import {
  cleanAuthHaltReason,
  EngineAuthError,
  EngineDetachedError,
  EngineSessionLimitError,
  isRetryableTransientError,
  NO_ENGINE_CREDENTIAL_MARKER,
} from './engine.types';

describe('cleanAuthHaltReason', () => {
  it('maps a no-credential marker message to the "connect an account" copy', () => {
    const raw = `${NO_ENGINE_CREDENTIAL_MARKER}: no claude subscription secret — the org has no claude credential set`;
    expect(cleanAuthHaltReason(raw)).toBe(
      'No Claude account is connected for this org — connect one in Settings, then resume.',
    );
  });

  it('maps a raw SDK "Not logged in" message to the generic reconnect copy and never leaks the raw text', () => {
    const clean = cleanAuthHaltReason('Not logged in · Please run /login');
    expect(clean).toBe(
      'Your Claude login needs to be reconnected — reconnect the account in Settings, then resume.',
    );
    expect(clean).not.toMatch(/not logged in|\/login/i);
  });

  it('names Codex (not Claude) when a Codex auth halt supplies the failing engine', () => {
    const noCred = `${NO_ENGINE_CREDENTIAL_MARKER}: no codex subscription secret — the org has no codex credential set`;
    expect(cleanAuthHaltReason(noCred, 'codex')).toBe(
      'No Codex account is connected for this org — connect one in Settings, then resume.',
    );
    // A raw mid-turn 401 (no engine hint in the text) still renders Codex copy from the passed engine.
    expect(cleanAuthHaltReason('401 Unauthorized', 'codex')).toBe(
      'Your Codex login needs to be reconnected — reconnect the account in Settings, then resume.',
    );
  });
});

describe('isRetryableTransientError', () => {
  it('retries a TRANSIENT auth hiccup (a self-healing "not logged in"/401)', () => {
    expect(isRetryableTransientError(new EngineAuthError('Not logged in'))).toBe(true);
  });

  it('retries host↔container transport / infra blips', () => {
    for (const msg of [
      'read ECONNRESET',
      'no such container: sandbox-abc',
      'Error: 502 Bad Gateway on the host hop',
      'redis connection lost',
    ]) {
      expect(isRetryableTransientError(new Error(msg))).toBe(true);
    }
  });

  it("does NOT retry SDK-owned API errors (overloaded / 529) — those are the SDK's own retry loop", () => {
    expect(isRetryableTransientError(new Error('overloaded_error'))).toBe(false);
    expect(isRetryableTransientError(new Error('529 overloaded'))).toBe(false);
    expect(isRetryableTransientError(new Error('Claude API request failed: 502 Bad Gateway'))).toBe(
      false,
    );
    expect(
      isRetryableTransientError(
        new Error(
          'Claude engine ended: error_during_execution; stderr(tail)=API Error: 503 Service Unavailable',
        ),
      ),
    ).toBe(false);
  });

  it('does NOT retry a deterministic-fatal or no-credential auth error', () => {
    expect(
      isRetryableTransientError(new EngineAuthError('Not logged in', undefined, undefined, true)),
    ).toBe(false);
    expect(
      isRetryableTransientError(
        new EngineAuthError(`${NO_ENGINE_CREDENTIAL_MARKER}: no claude secret`),
      ),
    ).toBe(false);
  });

  it('does NOT retry a session limit, a detached turn, or an unrecognized error', () => {
    expect(isRetryableTransientError(new EngineSessionLimitError('limit'))).toBe(false);
    expect(isRetryableTransientError(new EngineDetachedError('detached'))).toBe(false);
    expect(isRetryableTransientError(new Error('kaboom'))).toBe(false);
  });
});
