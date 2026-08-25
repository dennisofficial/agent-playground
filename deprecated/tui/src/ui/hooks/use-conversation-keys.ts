import { useInput } from "./use-input.js";
import type { OverlayItem } from "../components/overlay-list.js";
import type { ConversationService } from "../../app/conversation.service.js";
import type { ConversationStoreRegistry } from "../../app/conversation-store.registry.js";
import { EPageClaim, pageClaim } from "../../domain/composer-veto.js";
import type { DraftControls } from "./use-draft.js";

/**
 * The conversation page's keyboard contract, in one place.
 *
 * It lives apart from the page because it is the most-edited and most-reasoned-about part of it:
 * every binding here is a decision about what a key means while an agent is mid-turn, and those
 * decisions are worth reading without a hundred lines of JSX between them.
 *
 * WHICH keys are the page's is no longer decided here — `domain/composer-veto.ts` owns that as a
 * pure table, because the composer's editor is native and answers a key the moment it reaches it.
 * This hook asks that table first, stops the claimed keys from reaching the editor, and then does
 * the work. Everything unclaimed falls through to the buffer untouched, which is why ⌥←, ⌘←, ctrl+k
 * and ⌘Z need no mention here at all: they are the editor's, and always were meant to be.
 *
 * The arguments are flat and named rather than a handful of grouped bags: each one is read exactly
 * once below, and grouping them would only add a layer to look through while tracing a key.
 */
export function useConversationKeys(args: {
  composer: DraftControls;
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
  /** ctrl+v: pull an image off the system clipboard into the draft. */
  onPasteImage: () => void;
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

    const claim = pageClaim(
      {
        name: key.name,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
        super: key.super,
      },
      {
        empty: composer.value.length === 0,
        caretAtTop: composer.isCaretAtTop(),
        overlayOpen: overlay === "command",
      },
    );

    // Any key but esc means the user moved on; a discard warning left standing would make a later,
    // innocent esc an unwarned discard, which is the exact thing it exists to prevent.
    if (claim !== EPageClaim.escape && clearArmed) setClearArmed(false);

    if (claim === null) {
      // Unclaimed keys are the editor's — it has already typed them by the time anything here could
      // look. `/` on an EMPTY composer opens the palette, and the emptiness has to be read before
      // the key lands: the mirrored value is a render behind the buffer.
      if (input === "/" && composer.value.length === 0) setOverlay("command");
      return;
    }

    // Claimed. Stop it reaching the buffer, or ctrl+u would clear the draft AND delete to the line
    // start, and `←` would go back AND move a caret nobody can see any more.
    key.preventDefault();

    switch (claim) {
      case EPageClaim.overlayUp:
        return setSelected((s) => Math.max(0, s - 1));
      case EPageClaim.overlayDown:
        return setSelected((s) =>
          Math.min(filteredCommands.length - 1, s + 1),
        );
      case EPageClaim.overlayChoose: {
        const chosen = filteredCommands[selected];
        composer.setValue(chosen ? `${chosen.label} ` : composer.value);
        setOverlay("none");
        return;
      }

      case EPageClaim.escape: {
        if (overlay === "command") {
          setOverlay("none");
          composer.clear();
          return;
        }

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

        // The draft survives leaving the page, so a single key is the only way left to lose it by
        // accident. It takes two.
        setClearArmed(true);
        return;
      }

      case EPageClaim.submit:
        void submit();
        return;

      // Leaving never interrupts — the turn keeps running behind you.
      case EPageClaim.back:
        return args.onBack();
      // The job's OWN threads, not the job list: the switcher. Same promise as `←`.
      case EPageClaim.job:
      case EPageClaim.threads:
        return args.onThreads();

      case EPageClaim.clear:
        // Idle: clear the composer. Busy: clear the steer queue — the two things ctrl+u can mean.
        if (running) return conversationStores.for(args.threadId).clearQueue();
        return composer.clear();

      // Opening a thread lands you on the oldest thing you have not seen, so the transcript can
      // start scrolled away from the end — and the wheel is a long way back from four hundred
      // messages up.
      case EPageClaim.bottom:
        return args.onJumpToBottom();

      case EPageClaim.shortcuts:
        return setShortcuts((open) => !open);

      case EPageClaim.pasteImage:
        return args.onPasteImage();

      /**
       * ↑ with no row above it, and nothing to do about it.
       *
       * Claimed rather than ignored: unclaimed, the editor answers it, and an editor that cannot
       * move still swallows the key. Scrolling is the wheel's — PgUp/PgDn were bound here for a
       * while and never once worked, because a key only reached the transcript while it held focus,
       * and a transcript holding focus ALSO answered ↑/↓.
       */
      case EPageClaim.pastTop:
        return;

      // ctrl+a is the global accounts binding in `app.tsx`, which is a global handler too and fires
      // regardless. Claimed here only to keep it away from the editor, where it means line-home.
      case EPageClaim.accounts:
        return;
    }
  });
}
