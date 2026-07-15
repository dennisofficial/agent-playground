import { describe, expect, it } from 'vitest';
import {
  EngineAuthError,
  EngineSessionLimitError,
  UNRESUMABLE_SESSION_MARKER,
} from './engine.types';
import { summarizeTurnFailure } from './turn-failure-summary';

describe('summarizeTurnFailure', () => {
  it('classifies a typed EngineSessionLimitError as session_limit', () => {
    const result = summarizeTurnFailure(new EngineSessionLimitError('limit'));
    expect(result.category).toBe('session_limit');
    expect(result.summary).toBeTruthy();
  });

  it('classifies an untyped thrown limit message (the #231 shape) as session_limit', () => {
    const result = summarizeTurnFailure(new Error("You've hit your usage limit"));
    expect(result.category).toBe('session_limit');
    expect(result.summary).toBeTruthy();
  });

  it('classifies a typed EngineAuthError as auth', () => {
    const result = summarizeTurnFailure(new EngineAuthError('Not logged in'));
    expect(result.category).toBe('auth');
    expect(result.summary).toBeTruthy();
  });

  it('classifies an untyped thrown auth message as auth', () => {
    const result = summarizeTurnFailure(new Error('Not logged in · Please run /login'));
    expect(result.category).toBe('auth');
    expect(result.summary).toBeTruthy();
  });

  it('classifies a host-transport blip as transient', () => {
    const result = summarizeTurnFailure(new Error('read ECONNRESET'));
    expect(result.category).toBe('transient');
    expect(result.summary).toBeTruthy();
  });

  it('classifies an SDK-retry-exhausted overload as api_overloaded', () => {
    const result = summarizeTurnFailure(new Error('529 overloaded'));
    expect(result.category).toBe('api_overloaded');
    expect(result.summary).toBeTruthy();
  });

  it('classifies a lost sandbox container as sandbox_lost', () => {
    // NOTE: "no such container" itself is already inside HOST_TRANSPORT_TRANSIENT_RE (a host-retryable
    // transport blip), so it classifies as 'transient', not 'sandbox_lost' — checked separately below.
    // The sandbox_lost fallback regex only fires for its OTHER two signatures ('presumed dead'/'no events'),
    // which HOST_TRANSPORT_TRANSIENT_RE does not match.
    const result = summarizeTurnFailure(new Error('sandbox presumed dead — no events for 10m'));
    expect(result.category).toBe('sandbox_lost');
    expect(result.summary).toBeTruthy();
  });

  it("classifies a container-transport blip ('no such container') as transient, not sandbox_lost — HOST_TRANSPORT_TRANSIENT_RE wins first", () => {
    const result = summarizeTurnFailure(new Error('no such container: sandbox-abc'));
    expect(result.category).toBe('transient');
  });

  it('classifies an unresumable-session marker as unresumable', () => {
    const result = summarizeTurnFailure(new Error(`${UNRESUMABLE_SESSION_MARKER}: session gone`));
    expect(result.category).toBe('unresumable');
    expect(result.summary).toBeTruthy();
  });

  it('classifies an unrecognized error as unknown', () => {
    const result = summarizeTurnFailure(new Error('kaboom'));
    expect(result.category).toBe('unknown');
    expect(result.summary).toBeTruthy();
  });

  it('never treats a lowercased unresumable marker as unresumable — isUnresumableSessionMessage is case-sensitive', () => {
    const lowered = UNRESUMABLE_SESSION_MARKER.toLowerCase();
    const result = summarizeTurnFailure(new Error(`${lowered}: session gone`));
    expect(result.category).not.toBe('unresumable');
  });
});
