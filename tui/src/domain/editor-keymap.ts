const LINE_FEED = String.fromCharCode(10);

/** `ESC[27;<modifier>;13~` — xterm's modifyOtherKeys form of a modified Return. */
const MODIFIED_ENTER = /^\[27;\d+;13~$/;

export type KeyChord = {
  /**
   * The key's name, when the reporter has one — `left`, `backspace`, or the bare letter.
   *
   * Needed because an ESC-prefixed sequence carries no printable input: OpenTUI names `ESC b` as
   * `b` but hands over an empty string, since anything starting with ESC is navigation and must
   * never be typed into the draft. Without the name, Option-as-Meta's word bindings below are
   * unreachable.
   */
  name?: string;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  super?: boolean;
};

export type EditorCommand =
  | "insert-newline"
  | "delete-backward"
  | "delete-word-backward"
  | "delete-word-forward"
  | "delete-to-line-start"
  | "delete-to-line-end"
  | "move-left"
  | "move-right"
  | "move-word-left"
  | "move-word-right"
  | "move-line-start"
  | "move-line-end"
  | "move-up"
  | "move-down"
  | "move-doc-start"
  | "move-doc-end";

export function resolveEditorCommand(
  input: string,
  key: KeyChord,
): EditorCommand | null {
  // Ink sets `meta` on a bare Escape, so an unguarded `meta` test would turn Esc into an edit.
  if (key.escape) return null;

  if (key.leftArrow) {
    if (key.super) return "move-line-start";
    return key.meta || key.ctrl ? "move-word-left" : "move-left";
  }
  if (key.rightArrow) {
    if (key.super) return "move-line-end";
    return key.meta || key.ctrl ? "move-word-right" : "move-right";
  }

  // Terminal.app's Option-as-Meta sends the readline word bindings rather than modified arrows. The
  // letter arrives as the key's NAME, not as input — see `KeyChord.name`.
  if (key.meta && !key.ctrl) {
    const letter = input.length > 0 ? input : (key.name ?? "");
    if (letter === "b") return "move-word-left";
    if (letter === "f") return "move-word-right";
    if (letter === "d") return "delete-word-forward";
  }

  if (key.home) return key.ctrl ? "move-doc-start" : "move-line-start";
  if (key.end) return key.ctrl ? "move-doc-end" : "move-line-end";

  if (key.upArrow) return key.super ? "move-doc-start" : "move-up";
  if (key.downArrow) return key.super ? "move-doc-end" : "move-down";

  // Plain Return is deliberately not handled — the page owns submit.
  if (key.return && (key.shift || key.meta || key.ctrl))
    return "insert-newline";
  if (input === LINE_FEED) return "insert-newline";
  if (MODIFIED_ENTER.test(input)) return "insert-newline";

  // Ink reports plain Backspace as `delete`, so both flags mean "rub out backwards" here. Forward
  // delete is not separable in the legacy encoding: it reports identically.
  if (key.backspace || key.delete) {
    if (key.meta || key.ctrl) return "delete-word-backward";
    return "delete-backward";
  }

  if (key.ctrl) {
    if (input === "w") return "delete-word-backward";
    if (input === "k") return "delete-to-line-end";
    if (input === "e") return "move-line-end";
    // ctrl+a is the accounts page and ctrl+u clears the composer — both predate this keymap, so the
    // readline line-start binding is deliberately absent.
  }

  return null;
}

/** Commands that only move the caret — the ones that may fall through to the transcript. */
export function isMovement(command: EditorCommand): boolean {
  return command.startsWith("move-");
}
