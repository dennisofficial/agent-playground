import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ClaimService } from '../claim.service.js';
import { EClaimState } from '../../domain/claim.js';
import { jobClaimFile, jobDir } from '../../domain/paths.js';

/**
 * Against the real `~/.atlas`, under throwaway job ids that are removed after each test — the same
 * choice `worktree.service.spec.ts` makes. The point of these tests is the filesystem behaviour, so
 * faking the filesystem would test the fake.
 */
const ids: string[] = [];
const newJobId = (): string => {
  const id = `claim-spec-${randomUUID()}`;
  ids.push(id);
  return id;
};

afterEach(() => {
  for (const id of ids.splice(0)) rmSync(jobDir(id), { recursive: true, force: true });
});

describe('acquire and release', () => {
  it('claims a job and reads it back as ours', () => {
    const service = new ClaimService();
    const jobId = newJobId();

    expect(service.stateOf(jobId)).toBe(EClaimState.free);
    service.acquire(jobId);
    expect(service.stateOf(jobId)).toBe(EClaimState.mine);
  });

  it('records the pid that holds it', () => {
    const service = new ClaimService();
    const jobId = newJobId();
    service.acquire(jobId);
    expect(service.read(jobId)?.pid).toBe(process.pid);
  });

  it('releases what it holds', () => {
    const service = new ClaimService();
    const jobId = newJobId();
    service.acquire(jobId);
    service.release(jobId);

    expect(existsSync(jobClaimFile(jobId))).toBe(false);
    expect(service.stateOf(jobId)).toBe(EClaimState.free);
  });

  it('releasing an unclaimed job is a no-op rather than a throw', () => {
    const service = new ClaimService();
    expect(() => service.release(newJobId())).not.toThrow();
  });
});

describe('another terminal', () => {
  /** pid 1 is always alive and is never us — a live holder without spawning anything. */
  const claimedByLiveOther = (jobId: string): void => {
    mkdirSync(jobDir(jobId), { recursive: true });
    writeFileSync(
      jobClaimFile(jobId),
      JSON.stringify({ pid: 1, startedAt: 1, tty: '/dev/ttys004' }),
      'utf8',
    );
  };

  it('reads a live holder as held', () => {
    const service = new ClaimService();
    const jobId = newJobId();
    claimedByLiveOther(jobId);
    expect(service.stateOf(jobId)).toBe(EClaimState.held);
  });

  it('reads a dead holder as free, with no staleness window', () => {
    // The reason liveness is an OS probe: a crashed tile frees its job the instant it dies. pid 0 is
    // not a process anyone can hold, so `kill(0, 0)` fails with ESRCH.
    const service = new ClaimService();
    const jobId = newJobId();
    mkdirSync(jobDir(jobId), { recursive: true });
    writeFileSync(jobClaimFile(jobId), JSON.stringify({ pid: 2 ** 30, startedAt: 1, tty: null }));

    expect(service.stateOf(jobId)).toBe(EClaimState.free);
  });

  it('refuses to release a claim that has been taken over', () => {
    // The lockfile footgun. We held it, someone else took it, and our exit must not delete theirs.
    const service = new ClaimService();
    const jobId = newJobId();
    service.acquire(jobId);
    claimedByLiveOther(jobId);

    service.release(jobId);
    expect(existsSync(jobClaimFile(jobId))).toBe(true);
    expect(service.stateOf(jobId)).toBe(EClaimState.held);
  });

  it('takes a job that another terminal holds — last writer wins', () => {
    const service = new ClaimService();
    const jobId = newJobId();
    claimedByLiveOther(jobId);

    service.acquire(jobId);
    expect(service.stateOf(jobId)).toBe(EClaimState.mine);
  });
});

describe('corrupt claims', () => {
  it('reads a truncated file as unclaimed rather than throwing', () => {
    const service = new ClaimService();
    const jobId = newJobId();
    mkdirSync(jobDir(jobId), { recursive: true });
    writeFileSync(jobClaimFile(jobId), '{"pid":47');

    expect(service.stateOf(jobId)).toBe(EClaimState.free);
    expect(() => service.release(jobId)).not.toThrow();
  });
});

describe('statesFor', () => {
  it('answers for every job in one pass', () => {
    const service = new ClaimService();
    const mine = newJobId();
    const free = newJobId();
    service.acquire(mine);

    const states = service.statesFor([mine, free]);
    expect(states.get(mine)).toBe(EClaimState.mine);
    expect(states.get(free)).toBe(EClaimState.free);
  });
});

describe('watch', () => {
  it('fires when the claim changes under it, and stops when unsubscribed', async () => {
    const service = new ClaimService();
    const jobId = newJobId();
    let fired = 0;
    const stop = service.watch(jobId, () => {
      fired += 1;
    });

    // Polled to a deadline rather than slept past. fs.watch delivery is scheduled by the kernel, so
    // a fixed sleep is a bet on how loaded the machine is — which is how a real mechanism ends up
    // with a test that fails only in the full suite.
    service.acquire(jobId);
    const deadline = Date.now() + 2000;
    while (fired === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(fired).toBeGreaterThan(0);

    stop();
    const after = fired;
    service.release(jobId);
    await Bun.sleep(150);
    expect(fired).toBe(after);
  });
});
