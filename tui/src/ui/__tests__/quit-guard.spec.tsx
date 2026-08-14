import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import React, { act } from 'react';
import { useQuitGuard } from '../hooks/use-quit-guard.js';

/**
 * Ctrl+c, driven by real keypresses.
 *
 * The arm used to count working agents only, on the reasoning that *"turns are subprocesses of this
 * process, so quitting kills them"*. That stopped being the whole truth the moment services landed:
 * a service is a detached group the reaper kills on the way out, deliberately, and this banner is
 * the only notice anywhere in the app that a dev server is about to die.
 *
 * The failure this file exists to catch is silent — the guard renders perfectly well while warning
 * about the wrong thing, or while not warning at all, and the only other way to find out is to quit
 * Atlas by hand with a server running.
 */

const WIDTH = 80;
const HEIGHT = 6;

async function open(args: {
  agents: number;
  services: number;
  /** Real time, and short: the lapse is only testable if the test does not have to sit out three seconds. */
  armMs?: number;
}) {
  let quits = 0;
  let services = args.services;

  function Probe(): React.ReactNode {
    const armed = useQuitGuard({
      agents: args.agents,
      services: () => services,
      armMs: args.armMs,
      onQuit: () => {
        quits += 1;
      },
    });
    return <text>{armed ?? 'not armed'}</text>;
  }

  const setup = await testRender(
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <Probe />
    </box>,
    // The renderer's own ctrl+c handler would tear the whole thing down before ours ran — which is
    // exactly why `main.tsx` sets this too: quit is handled in-app so the session lock is released
    // first. A test that left it on would be testing OpenTUI's exit, not Atlas's guard.
    { width: WIDTH, height: HEIGHT, exitOnCtrlC: false },
  );
  await setup.flush();

  const press = async (run: () => void | Promise<void>): Promise<void> => {
    await act(async () => {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setup.flush();
    });
    await setup.flush();
  };

  return {
    setup,
    press,
    quits: (): number => quits,
    /** Changes the registry's count WITHOUT re-rendering — see the thunk test. */
    setServices: (count: number): void => {
      services = count;
    },
  };
}

describe('the ctrl+c guard', () => {
  it('quits on the first press when there is nothing to lose', async () => {
    const { setup, press, quits } = await open({ agents: 0, services: 0 });
    try {
      await press(() => setup.mockInput.pressCtrlC());
      expect(quits()).toBe(1);
      expect(setup.captureCharFrame()).toContain('not armed');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('warns about a working agent before it will quit', async () => {
    const { setup, press, quits } = await open({ agents: 2, services: 0 });
    try {
      await press(() => setup.mockInput.pressCtrlC());

      expect(quits()).toBe(0);
      expect(setup.captureCharFrame()).toContain('2 agents still working');
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * The one this slice is for. With no turn running, the old arm quit on the first press and took
   * the dev server with it — nothing anywhere said the process group was about to be signalled.
   */
  it('warns about a running service even when no agent is working', async () => {
    const { setup, press, quits } = await open({ agents: 0, services: 1 });
    try {
      await press(() => setup.mockInput.pressCtrlC());

      expect(quits()).toBe(0);
      expect(setup.captureCharFrame()).toContain('1 service running');
    } finally {
      setup.renderer.destroy();
    }
  });

  it('names both when both are true, in one sentence rather than two warnings', async () => {
    const { setup, press } = await open({ agents: 2, services: 1 });
    try {
      await press(() => setup.mockInput.pressCtrlC());

      expect(setup.captureCharFrame()).toContain(
        '2 agents still working · 1 service running',
      );
    } finally {
      setup.renderer.destroy();
    }
  });

  it('quits on the second press, which is what the first one promised', async () => {
    const { setup, press, quits } = await open({ agents: 1, services: 1 });
    try {
      await press(() => setup.mockInput.pressCtrlC());
      expect(quits()).toBe(0);

      await press(() => setup.mockInput.pressCtrlC());
      expect(quits()).toBe(1);
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * Armed is a moment, not a mode. Any other key means you are still working, and leaving the arm
   * standing would turn a later, innocent ctrl+c into an unwarned quit — the exact thing the warning
   * exists to prevent.
   */
  it('disarms on any other key', async () => {
    const { setup, press, quits } = await open({ agents: 1, services: 0 });
    try {
      await press(() => setup.mockInput.pressCtrlC());
      expect(setup.captureCharFrame()).toContain('1 agent still working');

      await press(() => setup.mockInput.typeText('x'));
      expect(setup.captureCharFrame()).toContain('not armed');

      await press(() => setup.mockInput.pressCtrlC());
      expect(quits()).toBe(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * The arm lapses on its own, and this is the only thing that says so: with the timer deleted the
   * whole suite still passes, because every other test presses again within milliseconds. A ctrl+c
   * ten minutes after the warning has to be warned about again — by then the sentence is gone from
   * the screen and the user has no idea they are one keystroke from killing a dev server.
   */
  it('lapses back to unarmed, so a much later press is warned about again', async () => {
    const { setup, press, quits } = await open({ agents: 1, services: 1, armMs: 50 });
    try {
      await press(() => setup.mockInput.pressCtrlC());
      expect(setup.captureCharFrame()).toContain('1 agent still working');

      await press(() => new Promise((resolve) => setTimeout(resolve, 120)));
      expect(setup.captureCharFrame()).toContain('not armed');

      await press(() => setup.mockInput.pressCtrlC());
      expect(quits()).toBe(0);
      expect(setup.captureCharFrame()).toContain('1 service running');
    } finally {
      setup.renderer.destroy();
    }
  });

  /**
   * The count is read AT THE MOMENT of the press, not at the last render — which is the whole reason
   * `services` is a thunk. Nothing renders this number, so a value captured at render time would be
   * as old as the last unrelated re-render: a service started since would go unwarned, and one that
   * died would be warned about after it was already gone.
   */
  it('counts the services at the press, not at the last render', async () => {
    const { setup, press, setServices } = await open({ agents: 0, services: 0 });
    try {
      setServices(2);
      await press(() => setup.mockInput.pressCtrlC());

      expect(setup.captureCharFrame()).toContain('2 services running');
    } finally {
      setup.renderer.destroy();
    }
  });
});
