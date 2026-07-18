import { describe, expect, it } from 'vitest';
import {
  applyStreamFrame,
  endLiveTurn,
  MAIN_LANE,
  peekLiveTurn,
  retryCountdownSeconds,
} from './job-stream';

// The store is module-global, so each test uses a unique jobId to stay isolated.
describe('job-stream turn_retry reducer', () => {
  it('a turn_retry frame sets retrying + active and keeps the lane mounted', () => {
    const jobId = 'job-retry-set';
    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: 'turn_start',
      startedAt: 100,
    });
    applyStreamFrame(jobId, MAIN_LANE, 2, { kind: 'text_delta', text: 'hi' });

    const nextAttemptAt = Date.now() + 8_000;
    applyStreamFrame(jobId, MAIN_LANE, 3, {
      kind: 'turn_retry',
      attempt: 3,
      max: 10,
      nextAttemptAt,
      reason: 'econnreset',
    });

    const turn = peekLiveTurn(jobId);
    expect(turn?.active).toBe(true);
    expect(turn?.retrying).toEqual({
      attempt: 3,
      max: 10,
      nextAttemptAt,
      reason: 'econnreset',
    });
    // Blocks + startedAt are untouched by a retry frame.
    expect(turn?.blocks).toHaveLength(1);
    expect(turn?.startedAt).toBe(100);
  });

  it('resolves a relative retryDelayMs (SDK api_retry) to an absolute nextAttemptAt once', () => {
    const jobId = 'job-retry-relative';
    const before = Date.now();
    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: 'turn_retry',
      attempt: 1,
      max: 10,
      retryDelayMs: 5_000,
    });
    const after = Date.now();
    const at = peekLiveTurn(jobId)?.retrying?.nextAttemptAt;
    expect(at).toBeGreaterThanOrEqual(before + 5_000);
    expect(at).toBeLessThanOrEqual(after + 5_000);
  });

  it('re-activates the lane even after a preceding turn_end cleared it (between-turns backstop)', () => {
    const jobId = 'job-retry-reactivate';
    applyStreamFrame(jobId, MAIN_LANE, 1, { kind: 'turn_start', startedAt: 1 });
    endLiveTurn(jobId, MAIN_LANE, 2);
    expect(peekLiveTurn(jobId)).toBeUndefined();

    applyStreamFrame(jobId, MAIN_LANE, 3, {
      kind: 'turn_retry',
      attempt: 1,
      max: 10,
      nextAttemptAt: Date.now() + 10_000,
    });
    const turn = peekLiveTurn(jobId);
    expect(turn?.active).toBe(true);
    expect(turn?.retrying?.attempt).toBe(1);
  });

  it('a following content frame clears retrying (the retry succeeded)', () => {
    const jobId = 'job-retry-clear';
    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: 'turn_retry',
      attempt: 2,
      max: 10,
      nextAttemptAt: Date.now() + 9_000,
    });
    expect(peekLiveTurn(jobId)?.retrying).toBeTruthy();

    applyStreamFrame(jobId, MAIN_LANE, 2, { kind: 'text_delta', text: 'back' });
    expect(peekLiveTurn(jobId)?.retrying).toBeUndefined();
  });

  it('a fresh turn_start clears retrying', () => {
    const jobId = 'job-retry-clear-turnstart';
    applyStreamFrame(jobId, MAIN_LANE, 1, {
      kind: 'turn_retry',
      attempt: 1,
      max: 10,
      nextAttemptAt: Date.now() + 9_000,
    });
    applyStreamFrame(jobId, MAIN_LANE, 2, { kind: 'turn_start', startedAt: 5 });
    expect(peekLiveTurn(jobId)?.retrying).toBeUndefined();
  });

  it('a snapshot carrying retrying restores it (reconnect mid-backoff)', () => {
    const jobId = 'job-retry-snapshot';
    const nextAttemptAt = Date.now() + 7_000;
    applyStreamFrame(jobId, MAIN_LANE, 5, {
      kind: 'snapshot',
      blocks: [],
      active: true,
      startedAt: 10,
      retrying: { attempt: 4, max: 10, nextAttemptAt, reason: 'auth' },
    });
    expect(peekLiveTurn(jobId)?.retrying).toEqual({
      attempt: 4,
      max: 10,
      nextAttemptAt,
      reason: 'auth',
    });
  });
});

describe('job-stream endLiveTurn seq-guard (finding-1)', () => {
  it('does NOT delete when a newer turn_retry landed after the turn_end (stale end)', () => {
    const jobId = 'job-seqguard-survive';
    applyStreamFrame(jobId, MAIN_LANE, 10, {
      kind: 'turn_start',
      startedAt: 1,
    });
    // A turn_end at seq 11, then the host backstop's turn_retry at a HIGHER seq 12.
    applyStreamFrame(jobId, MAIN_LANE, 12, {
      kind: 'turn_retry',
      attempt: 1,
      max: 10,
      nextAttemptAt: Date.now() + 10_000,
    });
    // The async endLiveTurn for the seq-11 turn_end runs LATE — it must NOT delete the re-activated turn.
    endLiveTurn(jobId, MAIN_LANE, 11);
    expect(peekLiveTurn(jobId)).toBeTruthy();
    expect(peekLiveTurn(jobId)?.retrying?.attempt).toBe(1);
  });

  it('deletes normally when no newer frame followed the turn_end', () => {
    const jobId = 'job-seqguard-delete';
    applyStreamFrame(jobId, MAIN_LANE, 10, {
      kind: 'turn_start',
      startedAt: 1,
    });
    endLiveTurn(jobId, MAIN_LANE, 10);
    expect(peekLiveTurn(jobId)).toBeUndefined();
  });

  it('deletes when called without an endSeq (legacy callers)', () => {
    const jobId = 'job-seqguard-noseq';
    applyStreamFrame(jobId, MAIN_LANE, 10, {
      kind: 'turn_start',
      startedAt: 1,
    });
    endLiveTurn(jobId, MAIN_LANE);
    expect(peekLiveTurn(jobId)).toBeUndefined();
  });
});

describe('retryCountdownSeconds', () => {
  it('rounds up whole seconds remaining to the target', () => {
    expect(retryCountdownSeconds(10_000, 0)).toBe(10);
    expect(retryCountdownSeconds(8_200, 0)).toBe(9);
    expect(retryCountdownSeconds(1, 0)).toBe(1);
  });

  it('returns null once the target is past or undefined', () => {
    expect(retryCountdownSeconds(1_000, 1_000)).toBeNull();
    expect(retryCountdownSeconds(1_000, 2_000)).toBeNull();
    expect(retryCountdownSeconds(undefined, 0)).toBeNull();
  });
});
