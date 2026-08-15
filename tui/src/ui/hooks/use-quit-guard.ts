import { useEffect, useState } from "react";
import { quitWarning } from "../../domain/quit-warning.js";
import { useInput } from "./use-input.js";

/** How long the arm stands. Long enough to read the sentence, short enough not to become a mode. */
const ARM_MS = 3000;

/**
 * Ctrl+c, and the one press it asks for first.
 *
 * Quitting is the only exit that destroys work that is not on disk: a running turn's thinking is
 * gone, and a service is a detached process group the reaper kills on the way out with no other
 * notice anywhere in the app. So the first press says what it will cost and the second does it.
 *
 * A hook rather than four lines in `app.tsx` because the arm is FOUR coupled decisions — when to
 * warn, what the warning says, when it lapses, and what disarms it — and they were only ever
 * verifiable by quitting Atlas by hand. Here they are drivable by a keypress in a test.
 *
 * Returns the sentence being shown, or `null`. That IS the armed flag: there is no state in which
 * one exists without the other, and holding the sentence rather than recomputing it on render is
 * what stops the banner contradicting the decision it is describing — the second press quits
 * regardless of what has changed since the first.
 */
export function useQuitGuard(args: {
  /** Threads with a turn in flight. */
  agents: number;
  /**
   * Running services, read AT THE MOMENT of the press. A thunk rather than a number because
   * nothing renders this count: a hook feeding it would poll the registry behind every page in the
   * app to keep a value that is looked at once, immediately before a quit.
   */
  services: () => number;
  onQuit: () => void;
  /**
   * How long the arm stands, in ms. Injected only so a test can drive the lapse in real time
   * instead of waiting three seconds for it — the same shape `useTick` and `expandHome` already use.
   */
  armMs?: number;
}): string | null {
  const [armed, setArmed] = useState<string | null>(null);
  const armMs = args.armMs ?? ARM_MS;

  // Armed is a moment, not a mode. Left standing it would turn a later, innocent ctrl+c into an
  // unwarned quit — the exact thing the warning exists to prevent.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), armMs);
    return () => clearTimeout(timer);
  }, [armed, armMs]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      const warning = quitWarning({
        agents: args.agents,
        services: args.services(),
      });
      if (warning !== null && !armed) {
        setArmed(warning);
        return;
      }
      args.onQuit();
      return;
    }

    // Any other key means you are still working — the warning has served its purpose.
    if (armed) setArmed(null);
  });

  return armed;
}
