import { describe, expect, it } from 'bun:test';
import {
  describeStatus,
  EServiceStatus,
  formatUptime,
  isRunning,
  mayStillBeAlive,
  renderServiceList,
  type ServiceEntry,
} from '../services.js';

const NOW = 1_770_000_000_000;

function entry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'a1b2c3d4',
    jobId: 'job-1',
    command: 'pnpm dev',
    description: 'web dev server',
    cwd: '/repo',
    pid: 4321,
    pgid: 4321,
    logPath: '/home/x/.atlas/jobs/job-1/logs/a1b2c3d4.log',
    startedAt: NOW - 90_000,
    status: EServiceStatus.running,
    ...overrides,
  };
}

describe('formatUptime', () => {
  it('is coarse on purpose — nobody reads a dev server to the second', () => {
    expect(formatUptime(4_000)).toBe('4s');
    expect(formatUptime(59_999)).toBe('59s');
    expect(formatUptime(12 * 60_000)).toBe('12m');
    expect(formatUptime(3 * 3_600_000 + 7 * 60_000)).toBe('3h 07m');
  });

  // Clocks move backwards — NTP, a laptop waking — and a service that reads `-3s` old looks like a
  // bug in the registry rather than in the clock.
  it('never goes negative', () => {
    expect(formatUptime(-5_000)).toBe('0s');
  });
});

describe('describeStatus', () => {
  it('carries the exit code, which is the whole reason to look at an exited service', () => {
    expect(describeStatus(entry({ status: EServiceStatus.exited, exitCode: 1 }))).toBe(
      'exited (1)',
    );
    // Zero is a code, not an absence. `??` on it would report a clean exit as an unknown one.
    expect(describeStatus(entry({ status: EServiceStatus.exited, exitCode: 0 }))).toBe(
      'exited (0)',
    );
  });

  it('says plain exited when nothing recorded a code', () => {
    expect(describeStatus(entry({ status: EServiceStatus.exited }))).toBe('exited');
  });

  // `killed` is a more honest account of why a process is gone than the code it died with, so a
  // stop that also has an exit code still reads as killed.
  it('reports a killed service as killed even once its code has landed', () => {
    expect(
      describeStatus(entry({ status: EServiceStatus.killed, exitCode: 143 })),
    ).toBe('killed');
  });
});

describe('renderServiceList', () => {
  /**
   * The empty case is the one that matters. An agent that reads `[]` learns nothing; the sentence is
   * what tells a thread arriving after a seam where services come from at all.
   */
  it('answers an empty job in prose that names the tool', () => {
    const text = renderServiceList({ entries: [], now: NOW });
    expect(text).toContain('No services in this job');
    expect(text).toContain('service_start');
    expect(text).not.toContain('[]');
  });

  it('leads with the id, which is the only thing service_stop takes', () => {
    const text = renderServiceList({ entries: [entry()], now: NOW });
    expect(text.split('\n')[2]?.startsWith('a1b2c3d4')).toBe(true);
    expect(text).toContain('up 1m');
    expect(text).toContain('web dev server');
    expect(text).toContain('/home/x/.atlas/jobs/job-1/logs/a1b2c3d4.log');
  });

  it('counts what it lists, singular and plural', () => {
    expect(renderServiceList({ entries: [entry()], now: NOW })).toContain(
      '1 service in this job',
    );
    expect(
      renderServiceList({ entries: [entry(), entry({ id: 'ffff0000' })], now: NOW }),
    ).toContain('2 services in this job');
  });

  /**
   * A dead service keeps its row — its log is still worth reading — but nothing records WHEN it
   * died, so its only age is time since it started. Unlabelled that reads as "it ran for 1m" when
   * it may have fallen over in the first second, which is the opposite of what the reader needs.
   */
  it('labels a dead service\'s age as time since it started, never as uptime', () => {
    const text = renderServiceList({
      entries: [entry({ status: EServiceStatus.exited, exitCode: 0 })],
      now: NOW,
    });
    expect(text).toContain('exited (0)');
    expect(text).toContain('started 1m ago');
    expect(text).not.toContain('up 1m');
  });
});

describe('the two liveness predicates, which are deliberately not the same question', () => {
  it('isRunning is what a human is shown', () => {
    expect(isRunning(entry())).toBe(true);
    expect(isRunning(entry({ status: EServiceStatus.killed }))).toBe(false);
    expect(isRunning(entry({ status: EServiceStatus.exited, exitCode: 0 }))).toBe(false);
  });

  /**
   * The backstop's question is not "does Atlas call this running" but "has Atlas ever WATCHED this
   * process end" — and a group that has been signalled is `killed` in memory while it may still be
   * dying, or ignoring the signal outright. Sweeping only `running` on the way out drops exactly the
   * services a graceful reap had already started on, which is the case a quit hits every time.
   */
  it('mayStillBeAlive keeps a signalled group in scope until its exit has actually been seen', () => {
    expect(mayStillBeAlive(entry())).toBe(true);
    expect(mayStillBeAlive(entry({ status: EServiceStatus.killed }))).toBe(true);
    expect(mayStillBeAlive(entry({ status: EServiceStatus.killed, exitCode: 143 }))).toBe(false);
    expect(mayStillBeAlive(entry({ status: EServiceStatus.exited, exitCode: 0 }))).toBe(false);
  });
});
