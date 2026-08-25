import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import React, { act } from 'react';
import { serviceLogFile } from '../../domain/paths.js';
import { EServiceStatus, type ServiceEntry } from '../../domain/services.js';
import { ServicesPage } from '../pages/services.js';
import { ServicesProvider, type Services } from '../services.js';

/**
 * The only place a human can see or end a job's long-lived processes.
 *
 * The registry is faked, not the page: what is under test is which entry `k` reaches, which ones it
 * refuses, and that the page never reaches past the job it was opened on. A real registry here would
 * be spawning dev servers to assert a keybinding.
 */

const WIDTH = 100;
const HEIGHT = 24;

function entry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'a1b2c3d4',
    jobId: 'job-1',
    command: 'pnpm dev',
    description: 'web dev server',
    cwd: '/repo',
    pid: 4321,
    pgid: 4321,
    // The real path, built the way the registry builds it: the page collapses it against the
    // machine's actual home, so a made-up `/Users/someone/...` would never collapse and the
    // assertion below would be testing the fixture rather than the page.
    logPath: serviceLogFile({ jobId: 'job-1', serviceId: 'a1b2c3d4' }),
    startedAt: Date.now() - 90_000,
    status: EServiceStatus.running,
    ...overrides,
  };
}

async function open(entries: ServiceEntry[], stopDelays: Record<string, number> = {}) {
  const stopped: { jobId: string; id: string }[] = [];
  let backs = 0;

  const services = {
    serviceRegistryService: {
      listFor: (jobId: string): readonly ServiceEntry[] =>
        entries.filter((row) => row.jobId === jobId),
      allServices: (): readonly ServiceEntry[] => entries,
      stop: async (args: { jobId: string; id: string }): Promise<string> => {
        stopped.push(args);
        // Real stops resolve in whatever order the signals land, not in the order they were asked
        // for — the delay is how the out-of-order case below is made deterministic.
        const delay = stopDelays[args.id] ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return `Stopped \`${args.id}\``;
      },
    },
  } as unknown as Services;

  const setup = await testRender(
    <ServicesProvider services={services}>
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <ServicesPage
          jobId="job-1"
          jobTitle="atlas"
          onBack={() => {
            backs += 1;
          }}
        />
      </box>
    </ServicesProvider>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();

  // Inside `act`, or a state commit from a key handler lands after the frame it should have changed.
  // The wait is for the lone ESC byte, which the parser holds until a timeout says nothing followed.
  const press = async (run: () => void | Promise<void>): Promise<void> => {
    await act(async () => {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await setup.flush();
    });
    await setup.flush();
  };

  return { setup, press, stopped, backs: (): number => backs };
}

describe('the services page', () => {
  it('names the tool when there is nothing to show, so the empty page teaches', async () => {
    const { setup } = await open([]);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain('No services in this job');
      expect(frame).toContain('service_start');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('draws the description, the status and the log path the human is meant to copy', async () => {
    const { setup } = await open([entry()]);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain('web dev server');
      expect(frame).toContain('running');
      expect(frame).toContain('pnpm dev');
      // Collapsed, because the absolute form does not fit and the tail is the part that identifies
      // the file. A frame carrying the raw `/Users/` prefix means `collapseHome` stopped being called.
      expect(frame).toContain('~/.atlas/jobs/job-1/logs/a1b2c3d4.log');
      expect(frame).not.toContain(homedir());
    } finally {
      setup.renderer.destroy();
    }
  });

  it('says how a dead service died rather than just that it is gone', async () => {
    const { setup } = await open([
      entry({ status: EServiceStatus.exited, exitCode: 127 }),
    ]);
    try {
      expect(setup.captureCharFrame()).toContain('exited (127)');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('stops the service the cursor is on, and only that one', async () => {
    const { setup, press, stopped } = await open([
      entry(),
      entry({ id: 'ffff0000', description: 'prisma studio' }),
    ]);
    try {
      await press(() => setup.mockInput.pressArrow('down'));
      await press(() => setup.mockInput.typeText('k'));

      expect(stopped).toEqual([{ jobId: 'job-1', id: 'ffff0000' }]);
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * `k` on a service Atlas WATCHED exit would answer "already gone" — a correct sentence and a
   * pointless one. An exit code is the only honest record of a death actually seen, and the only
   * safe reason to stop signalling: a reaped process group can be reissued to something else.
   */
  it('refuses to stop a service it watched exit', async () => {
    const { setup, press, stopped } = await open([
      entry({ status: EServiceStatus.exited, exitCode: 0 }),
    ]);
    try {
      await press(() => setup.mockInput.typeText('k'));

      expect(stopped).toEqual([]);
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * The second press, and the whole reason the guard asks `stopAction` rather than `isRunning`.
   *
   * A group that ignores SIGTERM is recorded `killed` on delivery while it is still up and still
   * holding its port. Refusing here would leave the one service that needs insisting on the one
   * service this page cannot end — and this page is the only place a human can end one at all.
   */
  it('still stops a service that was signalled but has not been seen to die', async () => {
    const { setup, press, stopped } = await open([
      entry({ status: EServiceStatus.killed }),
    ]);
    try {
      await press(() => setup.mockInput.typeText('k'));

      expect(stopped).toEqual([{ jobId: 'job-1', id: 'a1b2c3d4' }]);
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * `printable()` returns the key NAME with a modifier held, so `ctrl+k` arrives at this handler as a
   * bare `k`. Killing a dev server is not something a mistyped chord gets to do.
   */
  it('does not kill on ctrl+k', async () => {
    const { setup, press, stopped } = await open([entry()]);
    try {
      await press(() => setup.mockInput.pressKey('k', { ctrl: true }));

      expect(stopped).toEqual([]);
    } finally {
      setup.renderer.destroy();
    }
  });

  // The notice is about the row you were on. Carried onto another row it reads as a report about a
  // service nobody touched.
  it('clears the stop notice when the cursor moves off the row it was about', async () => {
    const { setup, press } = await open([
      entry(),
      entry({ id: 'ffff0000', description: 'prisma studio' }),
    ]);
    try {
      await press(() => setup.mockInput.typeText('k'));
      expect(setup.captureCharFrame()).toContain('Stopped');

      await press(() => setup.mockInput.pressArrow('down'));
      expect(setup.captureCharFrame()).not.toContain('Stopped');
    } finally {
      setup.renderer.destroy();
    }
  });

  // The same rule on the slow path: clearing the notice is not enough if the stop that was still in
  // flight when you moved is allowed to write it back the moment it answers.
  it('does not let a stop still in flight put its notice back after the cursor moved', async () => {
    const { setup, press } = await open(
      [entry(), entry({ id: 'ffff0000', description: 'prisma studio' })],
      { a1b2c3d4: 300 },
    );
    try {
      await press(() => setup.mockInput.typeText('k'));
      await press(() => setup.mockInput.pressArrow('down'));
      // Well past the delay, so the answer has certainly arrived.
      await press(() => new Promise((resolve) => setTimeout(resolve, 350)));

      expect(setup.captureCharFrame()).not.toContain('Stopped');
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * Two kills in flight, answering out of order. Without the pending-id guard the slow answer lands
   * last and the footer names a service the human is no longer stopping.
   */
  it('shows the answer to the latest stop, not the last one to resolve', async () => {
    const { setup, press } = await open(
      [entry(), entry({ id: 'ffff0000', description: 'prisma studio' })],
      { a1b2c3d4: 400 },
    );
    try {
      await press(() => setup.mockInput.typeText('k'));
      await press(() => setup.mockInput.pressArrow('down'));
      await press(() => setup.mockInput.typeText('k'));
      // Past the slow stop's delay, so its answer has definitely arrived — and been discarded.
      await press(() => new Promise((resolve) => setTimeout(resolve, 400)));

      const frame = setup.captureCharFrame();
      expect(frame).toContain('Stopped `ffff0000`');
      expect(frame).not.toContain('Stopped `a1b2c3d4`');
    } finally {
      setup.renderer.destroy();
    }
  });

  // The header count is the only place the page says how many of these are actually alive.
  it('counts the live services apart from the total in its header', async () => {
    const { setup } = await open([
      entry(),
      entry({ id: 'ffff0000', status: EServiceStatus.exited, exitCode: 1 }),
    ]);
    try {
      expect(setup.captureCharFrame()).toContain('1 live · 2 total');
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * The case that tells the two predicates apart, and the reason the header does not say `running`.
   *
   * A group that ignored SIGTERM is `killed` in memory and still holding its port. The job list
   * marks that job with ⚙, so a header reading `0 …` underneath it would read as a broken mark
   * rather than as the far more interesting truth: this thing will not die.
   */
  it('counts a killed-but-not-yet-dead service as live, as the job list does', async () => {
    const { setup } = await open([
      entry({ id: 'ffff0000', status: EServiceStatus.killed }),
    ]);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain('1 live · 1 total');
      // Still `killed` in its own row — the header counts, the status column distinguishes.
      expect(frame).toContain('killed');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('shows what the stop answered, rather than leaving the row to speak for it', async () => {
    const { setup, press } = await open([entry()]);
    try {
      await press(() => setup.mockInput.typeText('k'));

      expect(setup.captureCharFrame()).toContain('Stopped');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('leaves on esc and on ←, which is how every other page is left', async () => {
    const { setup, press, backs } = await open([entry()]);
    try {
      await press(() => setup.mockInput.pressEscape());
      expect(backs()).toBe(1);

      await press(() => setup.mockInput.pressArrow('left'));
      expect(backs()).toBe(2);
    } finally {
      setup.renderer.destroy();
    }
  });

  // Services are job-owned. A page that listed another job's would invite exactly the question the
  // ownership model exists to never have to answer.
  it('shows nothing belonging to another job', async () => {
    const { setup } = await open([
      entry(),
      entry({ id: 'other', jobId: 'job-2', description: 'someone elses server' }),
    ]);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain('web dev server');
      expect(frame).not.toContain('someone elses server');
    } finally {
      setup.renderer.destroy();
    }
  });
});
