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

async function open(entries: ServiceEntry[]) {
  const stopped: { jobId: string; id: string }[] = [];
  let backs = 0;

  const services = {
    serviceRegistryService: {
      listFor: (jobId: string): readonly ServiceEntry[] =>
        entries.filter((row) => row.jobId === jobId),
      allServices: (): readonly ServiceEntry[] => entries,
      stop: async (args: { jobId: string; id: string }): Promise<string> => {
        stopped.push(args);
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
   * `k` on a corpse would answer "already gone" — a correct sentence and a pointless one. The guard
   * is what keeps the page from reporting on kills it did not make.
   */
  it('refuses to stop a service that has already exited', async () => {
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
