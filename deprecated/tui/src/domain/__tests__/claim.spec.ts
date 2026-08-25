import { describe, expect, it } from 'bun:test';
import {
  claimState,
  EClaimState,
  mayReleaseClaim,
  parseClaim,
  serialiseClaim,
  type Claim,
} from '../claim.js';

const claim = (over: Partial<Claim> = {}): Claim => ({
  pid: 4711,
  startedAt: 1_760_000_000_000,
  tty: '/dev/ttys004',
  ...over,
});

const alive = (): boolean => true;
const dead = (): boolean => false;

describe('parseClaim', () => {
  it('round-trips a claim', () => {
    expect(parseClaim(serialiseClaim(claim()))).toEqual(claim());
  });

  it('reads a truncated file as unclaimed rather than throwing', () => {
    // A half-written claim must cost a takeover prompt, never a tile that cannot open its own job.
    expect(parseClaim('{"pid":47')).toBeNull();
  });

  it('rejects a claim with no usable pid', () => {
    expect(parseClaim('{"startedAt":1}')).toBeNull();
    expect(parseClaim('{"pid":"4711","startedAt":1}')).toBeNull();
    expect(parseClaim('{"pid":0,"startedAt":1}')).toBeNull();
    expect(parseClaim('{"pid":4711.5,"startedAt":1}')).toBeNull();
  });

  it('rejects a claim with no start time — pid reuse would be undetectable', () => {
    expect(parseClaim('{"pid":4711}')).toBeNull();
  });

  it('tolerates a missing tty, which is only ever shown and never compared', () => {
    expect(parseClaim('{"pid":4711,"startedAt":1}')?.tty).toBeNull();
  });

  it('reads a non-object as unclaimed', () => {
    expect(parseClaim('null')).toBeNull();
    expect(parseClaim('"held"')).toBeNull();
    expect(parseClaim('[]')).toBeNull();
  });
});

describe('claimState', () => {
  it('calls a missing claim free', () => {
    expect(claimState({ claim: null, selfPid: 1, isAlive: alive })).toBe(EClaimState.free);
  });

  it('calls our own claim mine — re-entering your own job is not a takeover', () => {
    expect(claimState({ claim: claim({ pid: 99 }), selfPid: 99, isAlive: dead })).toBe(
      EClaimState.mine,
    );
  });

  it('calls a live holder held', () => {
    expect(claimState({ claim: claim(), selfPid: 1, isAlive: alive })).toBe(EClaimState.held);
  });

  it('calls a dead holder free with no staleness window at all', () => {
    // The whole reason liveness is an OS probe and not a heartbeat: a crashed tile frees its job
    // the instant it dies, not N seconds later.
    expect(claimState({ claim: claim(), selfPid: 1, isAlive: dead })).toBe(EClaimState.free);
  });

  it('never probes liveness for our own claim', () => {
    let probed = false;
    claimState({
      claim: claim({ pid: 7 }),
      selfPid: 7,
      isAlive: () => {
        probed = true;
        return true;
      },
    });
    expect(probed).toBe(false);
  });
});

describe('mayReleaseClaim', () => {
  it('lets a tile clean up its own claim', () => {
    expect(mayReleaseClaim({ claim: claim({ pid: 7 }), selfPid: 7 })).toBe(true);
  });

  it('refuses to delete a claim that has been taken over', () => {
    // The lockfile footgun: by the time the displaced tile exits, the file belongs to the tile that
    // took the job. Deleting it would silently unclaim a job someone else is actively driving.
    expect(mayReleaseClaim({ claim: claim({ pid: 8 }), selfPid: 7 })).toBe(false);
  });

  it('refuses when there is no claim to release', () => {
    expect(mayReleaseClaim({ claim: null, selfPid: 7 })).toBe(false);
  });
});
