import {
  isMovement,
  resolveEditorCommand,
  type EditorCommand,
  type KeyChord,
} from "./editor-keymap.js";
import {
  deleteBackward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  insert,
  insertNewline,
  moveDocEnd,
  moveDocStart,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  type EditorState,
} from "./text-editor.js";

export type KeyResult = {
  readonly next: EditorState;
  /** False means the composer had no use for the key — the arbitration rule between editing and
   *  scrolling the transcript. */
  readonly consumed: boolean;
};

export function applyKey(
  state: EditorState,
  input: string,
  key: KeyChord,
): KeyResult {
  const command = resolveEditorCommand(input, key);

  if (command) {
    // An empty buffer has nowhere to move, so navigation belongs to the transcript.
    if (isMovement(command) && state.text.length === 0)
      return { next: state, consumed: false };

    const next = apply(state, command);
    if (next === null) return { next: state, consumed: false };
    return { next, consumed: true };
  }

  if (input.length > 0 && !isControlChar(input) && !isEscapeRemnant(input)) {
    return { next: insert(state, input), consumed: true };
  }

  return { next: state, consumed: false };
}

/**
 * Ink strips the leading `ESC` from anything it cannot name and hands the rest over as ordinary
 * input, so an unbound `shift+⏎` on iTerm2 literally types `[27;2;13~` into the draft. Such
 * sequences arrive as ONE multi-character event while typed text arrives a character at a time, so
 * requiring both the CSI grammar and a digit keeps this from swallowing real input.
 */
function isEscapeRemnant(input: string): boolean {
  return input.length > 1 && /^\[[\d;:]+[~A-Za-z]$/.test(input);
}

function apply(state: EditorState, command: EditorCommand): EditorState | null {
  switch (command) {
    case "insert-newline":
      return insertNewline(state);
    case "delete-backward":
      return deleteBackward(state);
    case "delete-word-backward":
      return deleteWordBackward(state);
    case "delete-word-forward":
      return deleteWordForward(state);
    case "delete-to-line-start":
      return deleteToLineStart(state);
    case "delete-to-line-end":
      return deleteToLineEnd(state);
    case "move-left":
      return moveLeft(state);
    case "move-right":
      return moveRight(state);
    case "move-word-left":
      return moveWordLeft(state);
    case "move-word-right":
      return moveWordRight(state);
    case "move-line-start":
      return moveLineStart(state);
    case "move-line-end":
      return moveLineEnd(state);
    case "move-up":
      return moveUp(state);
    case "move-down":
      return moveDown(state);
    case "move-doc-start":
      return moveDocStart(state);
    case "move-doc-end":
      return moveDocEnd(state);
  }
}

function isControlChar(input: string): boolean {
  return input.length === 1 && input.charCodeAt(0) < 32;
}
