import { describe, expect, it } from 'bun:test';
import {
  describeStatus,
  EServiceStatus,
  formatUptime,
  isRunning,
  mayStillBeAlive,
  renderServiceList,
  serviceJobIds,
  servicesLayout,
  stopAction,
  EStopAction,
  uptimeCell,
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

  /**
   * The other record of a death, and the one with no exit code to show for it: a kill that came back
   * `ESRCH` is the kernel saying the group is already gone. Left "maybe alive" it would be signalled
   * for the rest of the session — and a reaped pgid can be reissued, so those signals eventually
   * reach a stranger. `exited` is written in exactly two places and both of them are deaths.
   */
  it('mayStillBeAlive takes an exit with no code as final, because only ESRCH writes one', () => {
    expect(mayStillBeAlive(entry({ status: EServiceStatus.exited }))).toBe(false);
    expect(stopAction(entry({ status: EServiceStatus.exited }))).toBe(EStopAction.gone);
  });
});

describe('serviceJobIds', () => {
  const previous: ReadonlySet<string> = new Set(['job-1']);

  /**
   * A job is marked while it may still be holding something, which is not the same as `running`: a
   * group that trapped SIGTERM is `killed` in memory and still on its port, and taking the mark away
   * there would remove the human's only sign of it at the moment it has become a problem.
   */
  it('names every job that may still be holding a service, and no others', () => {
    const ids = serviceJobIds({
      previous: new Set(),
      entries: [
        entry({ jobId: 'job-1' }),
        entry({ jobId: 'job-2', status: EServiceStatus.exited, exitCode: 0 }),
        entry({ jobId: 'job-3', status: EServiceStatus.killed }),
        entry({ jobId: 'job-4', status: EServiceStatus.killed, exitCode: 143 }),
      ],
    });
    expect([...ids]).toEqual(['job-1', 'job-3']);
  });

  it('counts a job once however many services it holds', () => {
    const ids = serviceJobIds({
      previous: new Set(),
      entries: [entry({ jobId: 'job-1' }), entry({ id: 'other', jobId: 'job-1' })],
    });
    expect([...ids]).toEqual(['job-1']);
  });

  // The identity is the whole point. This is read on a one-second poll behind the job list, and a
  // fresh Set every tick would repaint every row of it forever.
  it('returns the PREVIOUS set object when the membership has not moved', () => {
    const ids = serviceJobIds({ previous, entries: [entry({ jobId: 'job-1' })] });
    expect(ids).toBe(previous);
  });

  it('returns a new object the moment a job joins', () => {
    const ids = serviceJobIds({
      previous,
      entries: [entry({ jobId: 'job-1' }), entry({ id: 'other', jobId: 'job-2' })],
    });
    expect(ids).not.toBe(previous);
    expect([...ids].sort()).toEqual(['job-1', 'job-2']);
  });

  it('returns a new object the moment a job leaves', () => {
    const ids = serviceJobIds({ previous, entries: [] });
    expect(ids).not.toBe(previous);
    expect(ids.size).toBe(0);
  });

  // Equal SIZE is not equal membership — a swap keeps the count and changes everything.
  it('returns a new object when one job is swapped for another', () => {
    const ids = serviceJobIds({ previous, entries: [entry({ jobId: 'job-9' })] });
    expect(ids).not.toBe(previous);
    expect([...ids]).toEqual(['job-9']);
  });
});

describe('servicesLayout', () => {
  it('gives the description the room the fixed columns do not want', () => {
    const layout = servicesLayout(100);
    expect(layout.status).toBe(14);
    expect(layout.uptime).toBe(8);
    expect(layout.description).toBe(48);
  });

  /**
   * Every column together must not exceed the room the four-cell caret gutter leaves, or the row
   * escapes its box — the hazard the house has already shipped twice. The narrow widths are the
   * point: the fixed columns alone are 26 cells, so a layout that only ever shrinks the description
   * overruns below that and the invariant has to be checked exactly where it is hardest to hold.
   *
   * Stated against `width - GUTTER` rather than `width` because the caret is a fixed prefix the
   * layout does not get to shrink: on a three-column terminal the row is over budget before any
   * column is chosen, and the terminal clips it. Everything the function DOES control is bounded.
   */
  it('never draws a row wider than the terminal, at any width at all', () => {
    for (let width = 0; width <= 200; width += 1) {
      const layout = servicesLayout(width);
      const columns = layout.description + layout.status + layout.uptime;
      expect(columns).toBeLessThanOrEqual(Math.max(0, width - 4));
    }
  });

  /**
   * The detail lines' own budget, and it is NOT the tautology it looks like: the assertion hard-codes
   * 6 while `servicesLayout` uses the named `INDENT`, so it is the constant that is pinned. The page
   * indents these two lines with a literal six spaces (`services.tsx`), and this is the only thing
   * holding that literal and the constant together — move one without the other and a log path draws
   * off the edge of the terminal.
   */
  it('keeps the detail lines inside the terminal too, allowing for their indent', () => {
    for (let width = 0; width <= 200; width += 1) {
      expect(servicesLayout(width).detail).toBeLessThanOrEqual(Math.max(0, width - 6));
    }
  });

  // `exited (127)` is twelve cells and is the widest real status. A narrower column would clip the
  // exit code, which is the only part of that string anyone reads.
  it('holds the widest real status without clipping it', () => {
    expect(servicesLayout(100).status).toBeGreaterThan('exited (127)'.length);
  });

  /**
   * Longest-first, like `jobsLayout`: uptime is the first column worth losing, then the status. What
   * never goes is the description, because a row that does not say what the service IS identifies
   * nothing — and neither does one that has drawn off the edge of the screen.
   */
  it('drops the uptime, then the status, rather than overrunning', () => {
    expect(servicesLayout(40).uptime).toBe(0);
    expect(servicesLayout(40).status).toBe(14);
    expect(servicesLayout(30).status).toBe(0);
    expect(servicesLayout(30).description).toBeGreaterThan(0);
  });

  it('does not go negative on an absurdly narrow terminal', () => {
    const layout = servicesLayout(2);
    expect(layout.description).toBeGreaterThanOrEqual(0);
    expect(layout.detail).toBeGreaterThanOrEqual(0);
  });
});

describe('uptimeCell', () => {
  it('says how long a live service has been up', () => {
    expect(uptimeCell({ entry: entry(), now: NOW })).toBe('up 1m');
  });

  /**
   * Nothing records when a dead service DIED — only when it started. `up 1m` beside `exited (127)`
   * would read as "it ran for a minute" when it may have fallen over in the first second, and every
   * short label for the true fact ("1m old", "1m ago") reads the same wrong way beside that status.
   * So the column says nothing, and `describeStatus` is left to be the whole of the answer.
   */
  it('says nothing at all for a service that is no longer running', () => {
    expect(uptimeCell({ entry: entry({ status: EServiceStatus.exited, exitCode: 1 }), now: NOW })).toBe('');
    expect(uptimeCell({ entry: entry({ status: EServiceStatus.killed }), now: NOW })).toBe('');
  });
});

describe('stopAction', () => {
  it('sends SIGTERM to a service nobody has signalled yet', () => {
    expect(stopAction(entry())).toBe(EStopAction.term);
  });

  /**
   * The second press, and the reason this is a function rather than an `isRunning` check.
   *
   * `stop` records `killed` the moment the signal is DELIVERED, not when the process dies — so a
   * group that ignores SIGTERM outright reads as `killed` while it still holds its port. Refusing
   * the second press would leave the only page that can kill a service unable to insist on the one
   * service that needs insisting on. This is the same escalation `reapGracefully` performs.
   */
  it('escalates to SIGKILL for a signalled group Atlas has never watched die', () => {
    expect(stopAction(entry({ status: EServiceStatus.killed }))).toBe(EStopAction.kill);
  });

  // `exitCode` is written by the exit watcher and nowhere else, so its presence is the one honest
  // record of "we saw this die". Signalling a reaped pgid risks hitting whatever inherited it.
  it('refuses a service Atlas has watched exit, however it exited', () => {
    expect(stopAction(entry({ status: EServiceStatus.exited, exitCode: 0 }))).toBe(EStopAction.gone);
    expect(stopAction(entry({ status: EServiceStatus.killed, exitCode: 143 }))).toBe(EStopAction.gone);
  });
});
