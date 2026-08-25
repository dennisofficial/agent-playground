/**
 * Who gets the key: the page, or the editor in the composer.
 *
 * The composer used to get first refusal — `applyKey` reported `consumed`, and whatever it declined
 * fell to the page. A native editor cannot answer that question in time: `handleKeyPress` returns a
 * boolean React never sees. So the arbitration inverts. OpenTUI dispatches GLOBAL key handlers
 * before the focused renderable's and skips the renderable when one calls `preventDefault()`, which
 * means the page can decide FIRST and take only what it means to take.
 *
 * This function is the whole rule, and it is pure so that "what does ↑ do here" is a table you can
 * read rather than a control flow you have to simulate. Everything it returns `null` for reaches the
 * editor untouched — including the readline bindings Atlas never spent, which are now the editor's
 * and better than the versions we hand-rolled.
 */

export enum EPageClaim {
  /** Plain ⏎. Every modified Return is a newline and belongs to the editor. */
  submit = "submit",
  /** Esc: interrupt a running turn, or arm the draft discard. */
  escape = "escape",
  /** ← on an empty draft. Leaving never interrupts. */
  back = "back",
  /** → on an empty draft: down into the job — its phases, its threads, its worktree. */
  job = "job",
  /** ↑ with no row above it. Nothing happens, and that is deliberate — see the note below. */
  pastTop = "past-top",
  /** ctrl+u: clear the draft, or the steer queue while a turn is running. */
  clear = "clear",
  /** ctrl+b: jump the transcript to the bottom. */
  bottom = "bottom",
  /** ctrl+h: this job's other threads. */
  threads = "threads",
  /** ctrl+a: the accounts page, from anywhere. */
  accounts = "accounts",
  /** `?` on an empty draft toggles the keymap in the footer. */
  shortcuts = "shortcuts",
  /**
   * ctrl+v: an image off the system clipboard.
   *
   * ⌘V is the terminal's — it turns the clipboard into a bracketed paste, which for a picture is the
   * empty string. ctrl+v is the one Atlas can actually see, and the editor binds it to nothing.
   */
  pasteImage = "paste-image",
  overlayUp = "overlay-up",
  overlayDown = "overlay-down",
  overlayChoose = "overlay-choose",
}

export type VetoChord = {
  /** The reporter's name for the key — `left`, `backspace`, or the bare character. */
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  /** ⌘ on macOS. The editor binds it to the visual line ends and to undo. */
  super?: boolean;
};

/** What the page knows about the draft when the key arrives. */
export type DraftFacts = {
  empty: boolean;
  /**
   * The caret is on the draft's first VISUAL row — the row a person sees, not the first
   * `\n`-separated line. The native editor answers this from `visualCursor`, and it is the whole
   * reason `↑` now walks a wrapped paragraph instead of falling out of the box on the first press.
   */
  caretAtTop: boolean;
  /** The command palette is up and owns the list keys. */
  overlayOpen: boolean;
};

export function pageClaim(key: VetoChord, draft: DraftFacts): EPageClaim | null {
  // Any modifier at all and this is the editor's business: ⌥← is a word, ⌘← is a line end, and
  // shift+⏎ is a newline. The page's claims below are all on BARE keys, and testing that here once
  // is what keeps each of them from having to say so.
  const bare = !key.ctrl && !key.meta && !key.super;

  if (bare && key.name === "escape") return EPageClaim.escape;

  if (draft.overlayOpen && bare) {
    if (key.name === "up") return EPageClaim.overlayUp;
    if (key.name === "down") return EPageClaim.overlayDown;
    if (key.name === "return") return EPageClaim.overlayChoose;
  }

  if (bare && key.name === "return" && !key.shift) return EPageClaim.submit;

  if (bare && draft.empty) {
    // Deliberately a different key from `esc`, which means "stop what you are doing". Overloading
    // esc with "and also leave" makes the key you reach for when walking away from a working agent
    // the one that kills it.
    if (key.name === "left") return EPageClaim.back;
    if (key.name === "right") return EPageClaim.job;
    if (key.name === "?") return EPageClaim.shortcuts;
  }

  /**
   * ↑ with nowhere left to go.
   *
   * The page claims it so the key stops at the composer's edge rather than doing something
   * surprising, and then does nothing with it — scrolling is the wheel's, and ↑ past the top is
   * reserved. Claiming it and doing nothing is not the same as leaving it unclaimed: unclaimed, the
   * editor would answer it, and an editor that cannot move still consumes the key.
   */
  if (bare && key.name === "up" && draft.caretAtTop) return EPageClaim.pastTop;

  if (key.ctrl && !key.meta && !key.super) {
    // The four Atlas spent before the native editor arrived with its own opinion about them. Every
    // other readline binding — ctrl+k, ctrl+w, ctrl+e — is left to the editor on purpose.
    if (key.name === "u") return EPageClaim.clear;
    if (key.name === "b") return EPageClaim.bottom;
    if (key.name === "h") return EPageClaim.threads;
    if (key.name === "a") return EPageClaim.accounts;
    if (key.name === "v") return EPageClaim.pasteImage;
  }

  return null;
}
