import { useCallback, useEffect, useMemo, useState } from "react";
import {
  closeThreadDetail,
  closeThreadQuestion,
  openableRoles,
  openThreadTitle,
  startPhaseTitle,
  startablePhases,
} from "../../domain/human-verbs.js";
import type { EPhaseKind } from "../../generated/prisma/enums.js";
import type { Thread } from "../../generated/prisma/client.js";
import type { OverlayItem } from "../components/overlay-list.js";
import { useServices } from "../services.js";
import type { InputKey } from "./use-input.js";

/**
 * Which of the human's verbs owns the keyboard. Exactly one at a time, and `browse` is the page's
 * own — the same arbitration the jobs page's `Mode` makes, for the same reason.
 */
export enum EHumanVerb {
  browse = "browse",
  /** The start-a-phase menu: every phase, the current one's `next` first. */
  phase = "phase",
  /** The open-a-thread menu: exactly `PHASE_SPECS[phase].roles`. */
  role = "role",
  /** Closing the highlighted thread, waiting for the second key. */
  close = "close",
}

/** The thread the close verb acts on — whatever the page's cursor is standing on. */
export type VerbTarget = {
  id: string;
  role: Thread["role"];
  closed: boolean;
  running: boolean;
  /** Whether it is the last thread still open in its phase. Only changes the wording. */
  last: boolean;
};

export type HumanVerbControls = {
  verb: EHumanVerb;
  /** The menu, where one is up. Empty in every other state. */
  items: OverlayItem[];
  selected: number;
  title: string;
  caption: string;
  /** The close verb's two lines. Null unless it is armed. */
  confirm: { question: string; detail: string } | null;
  busy: boolean;
  error: string | null;
  /**
   * Whether a verb claimed this key. The page's own listener calls this FIRST and returns on true —
   * the `applyKey`-returns-consumed rule the composer already arbitrates by, because every
   * `useKeyboard` listener fires for every key and there is no propagation to stop.
   */
  handleKey: (input: string, key: InputKey) => boolean;
};

/**
 * Start a phase, open a thread, close a thread — the page half.
 *
 * A hook rather than page state because the threads page is a list with a cursor and these are three
 * modal menus over it; inlining them would bury the one thing worth reading in that file, which is
 * which mode claims which key.
 *
 * The current phase is READ from the store, not inferred from the last row on screen. Both creation
 * verbs act on the current phase — the highest ordinal — and an agent may have moved the job while
 * the list was up.
 */
export function useHumanVerbs(args: {
  jobId: string;
  /** Where a thread opened from here runs. The same cwd the page's route carries. */
  cwd: string;
  target: VerbTarget | undefined;
  /** Anything that may have moved the phase under us — the page's reload signal. */
  revision: number;
  /** Re-read the list: a verb wrote rows it is showing. */
  onChanged: () => void;
  /** Where a newly created thread takes you. Nothing navigates on a close. */
  onOpened: (thread: Thread) => void;
}): HumanVerbControls {
  const { humanVerbsService } = useServices();
  const [phase, setPhase] = useState<EPhaseKind | null>(null);
  const [verb, setVerb] = useState<EHumanVerb>(EHumanVerb.browse);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void humanVerbsService
      .currentPhase(args.jobId)
      .then((current) => {
        if (live) setPhase(current.kind);
      })
      // A phase that could not be read is a menu that does not open. The next reload asks again,
      // and a transient SQLite busy must never put an error over a list that is fine.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [humanVerbsService, args.jobId, args.revision]);

  const phases = useMemo(
    () => (phase === null ? [] : startablePhases(phase)),
    [phase],
  );
  const roles = useMemo(
    () => (phase === null ? [] : openableRoles(phase)),
    [phase],
  );

  const leave = useCallback(() => {
    setVerb(EHumanVerb.browse);
    setSelected(0);
  }, []);

  const run = useCallback(
    (act: () => Promise<Thread | null>) => {
      setBusy(true);
      setError(null);
      void act()
        .then((thread) => {
          leave();
          args.onChanged();
          // Opening is a place to be, so it takes you there. Closing is not, so it does not.
          if (thread) args.onOpened(thread);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setBusy(false));
    },
    [args, leave],
  );

  const handleKey = useCallback(
    (input: string, key: InputKey): boolean => {
      // Mid-write. Swallow everything rather than queueing a second phase behind the first.
      if (busy) return verb !== EHumanVerb.browse;

      if (verb === EHumanVerb.close) {
        // `y` and nothing else, exactly as the bar says and exactly as the jobs page's delete asks.
        // Any other key cancels, so a reflexive `⏎` is a step back rather than a closed thread.
        if (input === "y" && args.target) {
          const { jobId } = args;
          const threadId = args.target.id;
          run(async () => {
            await humanVerbsService.closeThread({ jobId, threadId });
            return null;
          });
          return true;
        }
        leave();
        return true;
      }

      if (verb === EHumanVerb.phase || verb === EHumanVerb.role) {
        const length = verb === EHumanVerb.phase ? phases.length : roles.length;
        if (key.escape || key.leftArrow) {
          leave();
          return true;
        }
        if (key.upArrow) {
          setSelected((index) => Math.max(0, index - 1));
          return true;
        }
        if (key.downArrow) {
          setSelected((index) => Math.min(length - 1, index + 1));
          return true;
        }
        if (key.return || key.rightArrow) {
          const { jobId, cwd } = args;
          if (verb === EHumanVerb.phase) {
            const chosen = phases[selected];
            if (chosen) {
              run(async () =>
                (await humanVerbsService.startPhase({ jobId, kind: chosen.kind, cwd })).thread,
              );
            }
            return true;
          }
          const chosen = roles[selected];
          if (chosen) {
            run(async () =>
              humanVerbsService.openThread({ jobId, role: chosen.role, cwd }),
            );
          }
          return true;
        }
        // Everything else is swallowed: a menu that let `↑` fall through to the list underneath
        // would move a cursor the user cannot see while he is choosing.
        return true;
      }

      // Browsing. A verb only claims its own key, and only where the phase behind it has loaded.
      if (key.ctrl || key.meta) return false;
      if (input === "p" && phase !== null) {
        setError(null);
        setSelected(0);
        setVerb(EHumanVerb.phase);
        return true;
      }
      if (input === "n" && roles.length > 0) {
        setError(null);
        setSelected(0);
        setVerb(EHumanVerb.role);
        return true;
      }
      // Only an OPEN thread can be closed, so `c` on a finished leg is not a key at all.
      if (input === "c" && args.target && !args.target.closed) {
        setError(null);
        setVerb(EHumanVerb.close);
        return true;
      }
      return false;
    },
    [args, busy, humanVerbsService, leave, phase, phases, roles, run, selected, verb],
  );

  const items = useMemo<OverlayItem[]>(() => {
    if (verb === EHumanVerb.phase) {
      return phases.map((choice) => ({
        id: choice.kind,
        label: choice.label,
        // The suggestion is a hint, never a gate: the unmarked entries are exactly as legal.
        ...(choice.suggested ? { hint: "proposed from here" } : {}),
      }));
    }
    if (verb === EHumanVerb.role) {
      return roles.map((choice) => ({ id: choice.role, label: choice.label }));
    }
    return [];
  }, [phases, roles, verb]);

  return {
    verb,
    items,
    selected,
    title:
      phase === null
        ? ""
        : verb === EHumanVerb.phase
          ? startPhaseTitle(phase)
          : verb === EHumanVerb.role
            ? openThreadTitle(phase)
            : "",
    caption:
      verb === EHumanVerb.phase
        ? busy
          ? "starting…"
          : "↑↓ select · ⏎ start · esc cancel · every phase is reachable — the graph only rails the agent"
        : busy
          ? "opening…"
          : "↑↓ select · ⏎ open · esc cancel",
    confirm:
      verb === EHumanVerb.close && args.target
        ? {
            question: closeThreadQuestion(args.target.role),
            detail: closeThreadDetail({
              last: args.target.last,
              running: args.target.running,
            }),
          }
        : null,
    busy,
    error,
    handleKey,
  };
}
