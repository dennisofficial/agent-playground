/**
 * The cursor is a flat index into `text` rather than a row/column pair, so an edit can never leave
 * the two halves of the position disagreeing.
 *
 * `goalColumn` is the one piece of state that is not derivable: moving down from a long line to a
 * short one and back must return to the original column, not the short line's end.
 */
export type EditorState = {
  readonly text: string;
  readonly cursor: number;
  readonly goalColumn: number | null;
};

export const EMPTY_EDITOR: EditorState = { text: '', cursor: 0, goalColumn: null };

export function fromText(text: string): EditorState {
  return { text, cursor: text.length, goalColumn: null };
}

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

function clamp(cursor: number, text: string): number {
  if (cursor < 0) return 0;
  return cursor > text.length ? text.length : cursor;
}

function at(state: EditorState, cursor: number): EditorState {
  return { text: state.text, cursor: clamp(cursor, state.text), goalColumn: null };
}

export function toLines(text: string): string[] {
  return text.split('\n');
}

export function lineStartIndex(text: string, cursor: number): number {
  const previous = text.lastIndexOf('\n', cursor - 1);
  return previous === -1 ? 0 : previous + 1;
}

export function lineEndIndex(text: string, cursor: number): number {
  const next = text.indexOf('\n', cursor);
  return next === -1 ? text.length : next;
}

export function cursorRow(state: EditorState): number {
  let row = 0;
  for (let index = 0; index < state.cursor; index++) {
    if (state.text[index] === '\n') row++;
  }
  return row;
}

export function cursorColumn(state: EditorState): number {
  return state.cursor - lineStartIndex(state.text, state.cursor);
}

export function lineCount(text: string): number {
  return toLines(text).length;
}

/** Pasted text arrives here whole, so a multi-line paste needs no separate path — only newline
 *  normalisation, since terminals deliver `\r` for Return. */
export function insert(state: EditorState, chunk: string): EditorState {
  const normalised = chunk.replace(/\r\n?/g, '\n');
  const text = state.text.slice(0, state.cursor) + normalised + state.text.slice(state.cursor);
  return { text, cursor: state.cursor + normalised.length, goalColumn: null };
}

export function insertNewline(state: EditorState): EditorState {
  return insert(state, '\n');
}

function removeRange(state: EditorState, start: number, end: number): EditorState {
  if (start === end) return state;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return {
    text: state.text.slice(0, from) + state.text.slice(to),
    cursor: from,
    goalColumn: null,
  };
}

export function deleteBackward(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  return removeRange(state, state.cursor - 1, state.cursor);
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) return state;
  return removeRange(state, state.cursor, state.cursor + 1);
}

export function deleteWordBackward(state: EditorState): EditorState {
  return removeRange(state, wordLeftIndex(state), state.cursor);
}

export function deleteWordForward(state: EditorState): EditorState {
  return removeRange(state, state.cursor, wordRightIndex(state));
}

export function deleteToLineStart(state: EditorState): EditorState {
  return removeRange(state, lineStartIndex(state.text, state.cursor), state.cursor);
}

export function deleteToLineEnd(state: EditorState): EditorState {
  const end = lineEndIndex(state.text, state.cursor);
  // At the end of a line this swallows the newline instead, joining the next line up — which is what
  // ctrl+k does everywhere else and what makes repeated presses feel right.
  if (end === state.cursor) return removeRange(state, state.cursor, state.cursor + 1);
  return removeRange(state, state.cursor, end);
}

/** What a CLICK resolves to. Clamped, so a caller working from screen coordinates cannot put the
 *  caret outside the text by being one column optimistic. */
export function moveTo(state: EditorState, cursor: number): EditorState {
  return at(state, cursor);
}

export function moveLeft(state: EditorState): EditorState {
  return at(state, state.cursor - 1);
}

export function moveRight(state: EditorState): EditorState {
  return at(state, state.cursor + 1);
}

/** macOS opt+left: skip any boundary characters, then the word itself. */
function wordLeftIndex(state: EditorState): number {
  let index = state.cursor;
  while (index > 0 && !isWordChar(state.text[index - 1])) index--;
  while (index > 0 && isWordChar(state.text[index - 1])) index--;
  return index;
}

function wordRightIndex(state: EditorState): number {
  let index = state.cursor;
  const length = state.text.length;
  while (index < length && !isWordChar(state.text[index])) index++;
  while (index < length && isWordChar(state.text[index])) index++;
  return index;
}

export function moveWordLeft(state: EditorState): EditorState {
  return at(state, wordLeftIndex(state));
}

export function moveWordRight(state: EditorState): EditorState {
  return at(state, wordRightIndex(state));
}

export function moveLineStart(state: EditorState): EditorState {
  return at(state, lineStartIndex(state.text, state.cursor));
}

export function moveLineEnd(state: EditorState): EditorState {
  return at(state, lineEndIndex(state.text, state.cursor));
}

export function moveDocStart(state: EditorState): EditorState {
  return at(state, 0);
}

export function moveDocEnd(state: EditorState): EditorState {
  return at(state, state.text.length);
}

/**
 * `null` at the top of the buffer rather than a clamp, because "I could not move" is what lets the
 * caller hand `↑` to the transcript instead of stranding the user with a key that appears dead.
 */
export function moveUp(state: EditorState): EditorState | null {
  const start = lineStartIndex(state.text, state.cursor);
  if (start === 0) return null;

  const column = state.goalColumn ?? state.cursor - start;
  const previousStart = lineStartIndex(state.text, start - 1);
  const previousEnd = start - 1;
  const target = Math.min(previousStart + column, previousEnd);

  return { text: state.text, cursor: target, goalColumn: column };
}

export function moveDown(state: EditorState): EditorState | null {
  const end = lineEndIndex(state.text, state.cursor);
  if (end === state.text.length) return null;

  const column = state.goalColumn ?? state.cursor - lineStartIndex(state.text, state.cursor);
  const nextStart = end + 1;
  const nextEnd = lineEndIndex(state.text, nextStart);
  const target = Math.min(nextStart + column, nextEnd);

  return { text: state.text, cursor: target, goalColumn: column };
}
