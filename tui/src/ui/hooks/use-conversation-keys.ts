import { useInput } from "./use-input.js";
import type { OverlayItem } from "../components/overlay-list.js";
import type { ConversationService } from "../../app/conversation.service.js";
import type { ConversationStoreRegistry } from "../../app/conversation-store.registry.js";
import type { ComposerControls } from "./use-composer.js";

/**
 * The conversation page's keyboard contract, in one place.
 *
 * It lives apart from the page because it is the most-edited and most-reasoned-about part of it:
 * every binding here is a decision about what a key means while an agent is mid-turn, and those
 * decisions are worth reading without a hundred lines of JSX between them.
 *
 * The arguments are flat and named rather than a handful of grouped bags: each one is read exactly
 * once below, and grouping them would only add a layer to look through while tracing a key.
 */
export function useConversationKeys(args: {
  composer: ComposerControls;
  conversationService: ConversationService;
  conversationStores: ConversationStoreRegistry;
  threadId: string;
  running: boolean;
  /** The command palette: whether it is open, what it is offering, and where the cursor is. */
  overlay: "none" | "command";
  setOverlay: (overlay: "none" | "command") => void;
  filteredCommands: OverlayItem[];
  selected: number;
  setSelected: (update: (previous: number) => number) => void;
  /** Esc pressed once on a non-empty draft, waiting for the second. */
  clearArmed: boolean;
  setClearArmed: (armed: boolean) => void;
  setShortcuts: (update: (open: boolean) => boolean) => void;
  submit: () => Promise<void>;
  onBack: () => void;
  onThreads: () => void;
  /** The way back down from a landing on the oldest unseen message. */
  onJumpToBottom: () => void;
  /**
   * A confirm overlay is up and owns the keyboard.
   *
   * Every `useKeyboard` listener fires for every key and there is no propagation to stop, so the two
   * contracts cannot both be live: `y` would confirm a phase advance AND type a `y` into the draft.
   * The page stands down rather than the overlay competing — it is the one asking a question.
   */
  suspended?: boolean;
}): void {
  const {
    composer,
    conversationService,
    conversationStores,
    overlay,
    setOverlay,
    filteredCommands,
    selected,
    setSelected,
    clearArmed,
    setClearArmed,
    setShortcuts,
    submit,
    running,
  } = args;

  useInput((input, key) => {
    // Something else is asking a question — see `suspended`.
    if (args.suspended) return;

    // --- overlay navigation (opens upward; the composer never moves) -------------------------
    if (overlay === "command") {
      if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow)
        return setSelected((s) => Math.min(filteredCommands.length - 1, s + 1));
      if (key.escape) {
        setOverlay("none");
        composer.clear();
        return;
      }
      if (key.return) {
        const chosen = filteredCommands[selected];
        composer.setValue(chosen ? `${chosen.label} ` : composer.value);
        setOverlay("none");
        return;
      }
    }

    // --- leave, without touching the turn --------------------------------------------------------
    // `←` on an empty composer is BACK, and it is deliberately a different key from `esc`. Esc means
    // "stop what you are doing" here; overloading it with "and also leave" makes the two impossible
    // to separate, and the one you reach for when you want to walk away from a working agent is the
    // one that kills it. Leaving never interrupts — the turn keeps running.
    if (key.leftArrow && composer.value.length === 0) {
      args.onBack();
      return;
    }

    // `→` on an empty composer is the mirror: DOWN into the job itself — its phases, its threads, its
    // name, its worktree. The job's page used to be the frame beneath this one, revealed by `←`, so
    // walking away from a conversation and managing the job it belongs to were the same keypress.
    // They are opposite intentions, and they now travel in opposite directions.
    if (key.rightArrow && composer.value.length === 0) {
      args.onThreads();
      return;
    }

    // --- interrupt, or discard the draft ----------------------------------------------------------
    if (key.escape) {
      // Esc with an empty composer interrupts bare. Esc with text is a STEER-NOW: interrupt, then
      // deliver immediately rather than waiting for a boundary that will never come. Neither one
      // loses the draft, so neither one asks first.
      if (running) {
        const pending = composer.value.trim();
        composer.clear();
        void conversationService.interrupt(
          pending.length > 0 ? pending : undefined,
        );
        return;
      }

      // Idle and empty: esc has no work to do.
      if (composer.value.length === 0) return;

      if (clearArmed) {
        setClearArmed(false);
        composer.clear();
        return;
      }

      // The draft now survives leaving the page, so a single key is the only way left to lose it by
      // accident. It takes two.
      setClearArmed(true);
      return;
    }

    // Every other key means the user moved on; a warning left standing would make a later, innocent
    // esc an unwarned discard, which is the exact thing it exists to prevent.
    if (clearArmed) setClearArmed(false);

    if (key.ctrl && input === "u") {
      // Idle: clear the composer. Busy: clear the steer queue — the two things ctrl+u can mean.
      if (running)
        return conversationStores.for(args.threadId).clearQueue();
      return composer.clear();
    }
    // The job's OWN threads, not the job list: this is the switcher, and like `←` it never touches
    // the turn — the thread you leave keeps working while you read another one.
    if (key.ctrl && input === "h") return args.onThreads();
    // Bottom. Opening a thread lands you on the oldest thing you have not seen, which means the
    // transcript can now start scrolled away from the end — and the wheel is a long way back from
    // the top of four hundred messages. Ahead of the composer's refusal because ctrl+b is not one
    // of the readline bindings the editor claims.
    if (key.ctrl && input === "b") return args.onJumpToBottom();

    // `?` on an empty composer TOGGLES the keymap in the footer, where the hint line has always
    // advertised it. Non-empty, it is just a question mark — typing during a turn stays safe.
    if (
      input === "?" &&
      composer.value.length === 0 &&
      !key.ctrl &&
      !key.meta
    ) {
      return setShortcuts((open) => !open);
    }

    // Plain Return sends. Return with ANY modifier falls through to the composer as a newline.
    if (key.return && !key.shift && !key.meta && !key.ctrl) {
      void submit();
      return;
    }

    // --- the composer gets first refusal ------------------------------------------------------
    // It returns false for anything it cannot use — a caret already at the top, or any navigation
    // at all while empty. What it declines falls to the bindings below, NOT to the transcript:
    // scrolling is the wheel's job now that real wheel reports arrive.
    if (composer.handleKey(input, key)) {
      // `/` on an empty composer opens the palette. Typing during a busy turn is ALWAYS safe.
      if (input === "/" && composer.value.length === 1) setOverlay("command");
      return;
    }

    // Nothing below the composer's refusal can be a PRINTABLE key. `x` and `X` used to be bound here
    // to expand tool blocks, and could never once have fired: the composer consumes every printable
    // character, so the branch was unreachable and typing `x` simply typed an `x`. Expansion is the
    // pointer's job — see `useClickRegion`.

    // ↑↓ deliberately do NOT scroll — they belong to the composer's caret, and past it they are
    // reserved for navigation. Scrolling is the wheel's alone: PgUp/PgDn were claimed here for a
    // while and never worked, because a key only reached the transcript while it held focus — and a
    // transcript holding focus ALSO answered ↑/↓, which is the bug this comment used to describe as a
    // feature. Home/End belong to the draft's line, not the transcript's.
  });
}
