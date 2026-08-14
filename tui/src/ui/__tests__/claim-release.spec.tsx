import { testRender } from '@opentui/react/test-utils';
import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import React, { act, useState } from 'react';
import type { OpenConversation } from '../../app/conversation.service.js';
import type { ServiceRegistryService } from '../../app/service-registry.service.js';
import type { ProjectRow } from '../../app/workspace.service.js';
import type { Job } from '../../generated/prisma/client.js';
import { serialiseClaim } from '../../domain/claim.js';
import { jobClaimFile, jobDir } from '../../domain/paths.js';
import { useClaim } from '../hooks/use-claim.js';
import { heldJobId } from '../navigation.js';
import { ServicesProvider, type Services } from '../services.js';

/**
 * When a job's services are reaped, and — the part that matters — when they are NOT.
 *
 * A service is a child of the ATLAS process, not of a turn, which is what makes it survive turns and
 * seams and also what means nothing else will ever kill it. A takeover is the one moment it stops
 * having anyone watching it: another Atlas is now driving the job, and our children would sit on its
 * ports with nobody to stop them.
 *
 * Merely letting the claim go is NOT that moment. `heldJobId` is read off the top of the navigation
 * stack, so pushing a route that is not inside the job nulls it and releases the claim — ctrl+a to
 * the accounts page does exactly that. Releasing a claim is cheap and reversible; killing a process
 * group is neither, so they must not share a lifetime.
 *
 * Which routes count as being inside the job is the other half of the same rule, and is asserted at
 * the bottom of this file.
 */

const WIDTH = 40;
const HEIGHT = 4;
const jobs: string[] = [];

afterEach(() => {
  for (const jobId of jobs.splice(0)) {
    rmSync(jobDir(jobId), { recursive: true, force: true });
  }
});

function services(reaped: string[]): Services {
  return {
    serviceRegistryService: {
      reapJob(jobId: string): string[] {
        reaped.push(jobId);
        return [];
      },
    } as unknown as ServiceRegistryService,
  } as unknown as Services;
}

/** A live process that is not us — `claimState` only asks whether the holder's pid still exists. */
function claimForSomeoneElse(jobId: string): void {
  mkdirSync(jobDir(jobId), { recursive: true });
  writeFileSync(
    jobClaimFile(jobId),
    serialiseClaim({ pid: process.ppid, startedAt: 1, tty: '/dev/ttys999' }),
    'utf8',
  );
}

async function mount(args: { jobId: string; reaped: string[]; takenOver: string[] }) {
  let leave: (() => void) | null = null;

  function Probe(): React.ReactNode {
    const [held, setHeld] = useState<string | null>(args.jobId);
    leave = () => setHeld(null);
    useClaim({
      jobId: held,
      onTakenOver: () => args.takenOver.push(args.jobId),
    });
    return <text>probe</text>;
  }

  const setup = await testRender(
    <ServicesProvider services={services(args.reaped)}>
      <Probe />
    </ServicesProvider>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();
  return { setup, leave: () => leave?.() };
}

describe('useClaim', () => {
  /**
   * The critical one. Navigating away releases the claim, and if the reap rode along with it a
   * glance at the accounts page would SIGTERM a dev server with nothing said and nothing logged.
   */
  it('does not touch the services when the claim is merely let go', async () => {
    const jobId = `spec-claim-${randomUUID()}`;
    jobs.push(jobId);
    const reaped: string[] = [];
    const takenOver: string[] = [];

    const { setup, leave } = await mount({ jobId, reaped, takenOver });
    await act(async () => {
      leave();
      await setup.flush();
    });

    expect(reaped).toEqual([]);
    expect(takenOver).toEqual([]);
  });

  it('reaps them when another terminal takes the job', async () => {
    const jobId = `spec-claim-${randomUUID()}`;
    jobs.push(jobId);
    const reaped: string[] = [];
    const takenOver: string[] = [];

    const { setup, leave } = await mount({ jobId, reaped, takenOver });
    await act(async () => {
      claimForSomeoneElse(jobId);
      // `fs.watch` is a real OS watcher, so the callback arrives on its own schedule rather than on
      // the next tick. Everything else in this file is deterministic; only this has to be waited on.
      for (let attempt = 0; attempt < 100 && takenOver.length === 0; attempt += 1) {
        await Bun.sleep(20);
      }
      await setup.flush();
    });

    expect(reaped).toEqual([jobId]);
    // Reaped BEFORE the tile is told, so nothing has navigated away from a job still holding ports.
    expect(takenOver).toEqual([jobId]);

    // Let the hook's own `fs.watch` go before `afterEach` removes the folder under it. A watcher
    // left open on a deleted directory does not merely leak: it starved `claim.service.spec.ts`'s
    // watcher of events for two seconds when the whole suite ran, and only then.
    await act(async () => {
      leave();
      await setup.flush();
    });
  });
});

/**
 * Which pages hold the job, and the one that was missing.
 *
 * The failure here is invisible: the claim is a file and a watcher, nothing on screen draws it, and
 * a page that quietly drops it lets another terminal take the job out from under you with no notice
 * at all — the notice is rendered by the very hook the drop unmounts.
 */
describe('heldJobId', () => {
  const job = { id: 'job-1' } as Job;

  it('holds the job from the conversation and from the job page', () => {
    expect(
      heldJobId({
        name: 'conversation',
        project: {} as ProjectRow,
        open: { job } as OpenConversation,
      }),
    ).toBe('job-1');
    expect(
      heldJobId({
        name: 'threads',
        project: {} as ProjectRow,
        job,
        cwd: '/repo',
        currentThreadId: 'thread-1',
      }),
    ).toBe('job-1');
  });

  /**
   * The services page is the page you SIT on — watching a dev server, waiting for a build. Letting
   * the claim go here would make the one screen you leave open the one that gives the job away.
   */
  it('holds the job from the services page, which is where you watch one run', () => {
    expect(heldJobId({ name: 'services', jobId: 'job-1', jobTitle: 'atlas' })).toBe('job-1');
  });

  // Browsing holds nothing: a job you left ten seconds ago is immediately takeable, because you are
  // demonstrably not in it.
  it('holds nothing from a page that is not inside a job', () => {
    expect(heldJobId({ name: 'jobs', project: null })).toBeNull();
    expect(heldJobId({ name: 'accounts' })).toBeNull();
  });
});
