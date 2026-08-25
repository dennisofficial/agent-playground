import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { ATLAS_HOME } from '../../domain/paths.js';
import { NewJobPage } from '../pages/new-job.js';
import { ServicesProvider, type Services } from '../services.js';

/**
 * The blank page a job may or may not come out of, mounted for real.
 *
 * The test that matters is the one a green suite misses: walking away. A pending job is UI state,
 * so abandoning it must leave NOTHING — and the way that is guaranteed is that this page cannot
 * write, which is what the trap below asserts. Every service is a proxy that throws on any property
 * access at all, so a page that so much as reached for a repository would fail here rather than in
 * front of Dennis with an empty row on his job list.
 */

const WIDTH = 80;
const HEIGHT = 24;
const JOBS_DIR = join(ATLAS_HOME, 'jobs');

/** Every service, booby-trapped. Touching any of them is the failure this test is looking for. */
function trap(touched: string[]): Services {
  const service = new Proxy(
    {},
    {
      get(_target, property): never {
        const name = String(property);
        touched.push(name);
        throw new Error(`the pending-job page touched a service: ${name}`);
      },
    },
  );
  return new Proxy({} as Services, { get: (): unknown => service });
}

/** What Atlas has on disk for jobs right now — a folder appearing here is a job that got created. */
function jobFolders(): string[] {
  return existsSync(JOBS_DIR) ? readdirSync(JOBS_DIR).sort() : [];
}

async function open() {
  const submitted: string[] = [];
  const touched: string[] = [];
  let cancelled = 0;

  const setup = await testRender(
    <ServicesProvider services={trap(touched)}>
      <box flexDirection="column" width={WIDTH} height={HEIGHT}>
        <NewJobPage
          projectName="atlas"
          onSubmit={async (text) => {
            submitted.push(text);
          }}
          onCancel={() => {
            cancelled += 1;
          }}
        />
      </box>
    </ServicesProvider>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();

  // Inside `act`, or the state commit from a key handler never reaches the buffer — the harness
  // renders in `act`, so an event dispatched outside it lands after the frame it should have changed.
  const press = async (run: () => void | Promise<void>): Promise<void> => {
    await act(async () => {
      await run();
      // A lone ESC byte is the head of every arrow and function key, so the parser holds it until a
      // short timeout says nothing followed. Without the wait, `esc` never arrives at all.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await setup.flush();
    });
    await setup.flush();
  };

  return {
    setup,
    press,
    submitted,
    touched,
    cancelledCount: (): number => cancelled,
  };
}

describe('the new-job page', () => {
  it('opens on an empty composer, with no title asked for', async () => {
    const { setup } = await open();
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain('what do you want to do?');
      expect(frame).toContain('Nothing is saved until you send');
      // The old ceremony, gone: no prompt for a name, and nothing calling itself a title.
      expect(frame.toLowerCase()).not.toContain('title');
      expect(frame).toContain('new job');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('creates nothing when you type nothing and leave', async () => {
    const before = jobFolders();
    const { setup, press, submitted, touched, cancelledCount } = await open();
    try {
      await press(() => setup.mockInput.pressEscape());

      expect(submitted).toEqual([]);
      expect(cancelledCount()).toBe(1);
      expect(touched).toEqual([]);
      expect(jobFolders()).toEqual(before);
    } finally {
      setup.renderer.destroy();
    }
  });

  it('creates nothing when you type a paragraph and leave without sending', async () => {
    const before = jobFolders();
    const { setup, press, submitted, touched, cancelledCount } = await open();
    try {
      await press(() => setup.mockInput.typeText('rewrite the rotation policy'));
      expect(setup.captureCharFrame()).toContain('rewrite the rotation policy');

      // A draft is not thrown away on one keystroke — the first esc arms, the second discards.
      await press(() => setup.mockInput.pressEscape());
      expect(cancelledCount()).toBe(0);
      expect(setup.captureCharFrame()).toContain('esc again to discard');

      await press(() => setup.mockInput.pressEscape());
      expect(cancelledCount()).toBe(1);
      expect(submitted).toEqual([]);
      expect(touched).toEqual([]);
      expect(jobFolders()).toEqual(before);
    } finally {
      setup.renderer.destroy();
    }
  });

  it('sends the first message as it was typed', async () => {
    const { setup, press, submitted } = await open();
    try {
      await press(() => setup.mockInput.typeText('hey how does auth work?'));
      await press(() => setup.mockInput.pressEnter());

      expect(submitted).toEqual(['hey how does auth work?']);
    } finally {
      setup.renderer.destroy();
    }
  });

  it('refuses to start a job on an empty composer', async () => {
    const { setup, press, submitted, cancelledCount } = await open();
    try {
      await press(() => setup.mockInput.pressEnter());

      expect(submitted).toEqual([]);
      // And it is still standing here, rather than having quietly left.
      expect(cancelledCount()).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });
});
