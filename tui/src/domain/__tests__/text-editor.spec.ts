import { describe, expect, it } from 'bun:test';
import {
  EMPTY_EDITOR,
  cursorColumn,
  cursorRow,
  deleteBackward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  deleteWordForward,
  fromText,
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
} from '../text-editor.js';

/** `at('ab|c')` — the pipe marks the cursor, so the tests read like what the user sees. */
function at(marked: string): EditorState {
  const cursor = marked.indexOf('|');
  return { text: marked.replace('|', ''), cursor, goalColumn: null };
}

function show(state: EditorState): string {
  return `${state.text.slice(0, state.cursor)}|${state.text.slice(state.cursor)}`;
}

describe('insert', () => {
  it('types at the cursor rather than the end', () => {
    expect(show(insert(at('ab|cd'), 'X'))).toBe('abX|cd');
  });

  it('takes a multi-line paste whole', () => {
    expect(show(insert(EMPTY_EDITOR, 'one\ntwo'))).toBe('one\ntwo|');
  });

  it('normalises the CR a terminal sends for Return', () => {
    expect(insert(EMPTY_EDITOR, 'a\r\nb').text).toBe('a\nb');
    expect(insert(EMPTY_EDITOR, 'a\rb').text).toBe('a\nb');
  });
});

describe('deleting', () => {
  it('rubs out the character before the cursor', () => {
    expect(show(deleteBackward(at('ab|c')))).toBe('a|c');
  });

  it('does nothing at the very start', () => {
    expect(show(deleteBackward(at('|abc')))).toBe('|abc');
  });

  it('deletes a word backwards, boundary characters included', () => {
    expect(show(deleteWordBackward(at('one two |')))).toBe('one |');
  });

  it('deletes the word forwards', () => {
    expect(show(deleteWordForward(at('|one two')))).toBe('| two');
  });

  it('deletes to the start of the line only, not the whole buffer', () => {
    expect(show(deleteToLineStart(at('one\ntwo th|ree')))).toBe('one\n|ree');
  });

  it('deletes to the end of the line', () => {
    expect(show(deleteToLineEnd(at('one tw|o\nthree')))).toBe('one tw|\nthree');
  });

  it('joins the next line up when already at the end of one', () => {
    // What ctrl+k does everywhere else, and what makes repeated presses feel right.
    expect(show(deleteToLineEnd(at('one|\ntwo')))).toBe('one|two');
  });
});

describe('horizontal movement', () => {
  it('steps one character and stops at each end', () => {
    expect(show(moveLeft(at('a|b')))).toBe('|ab');
    expect(show(moveLeft(at('|ab')))).toBe('|ab');
    expect(show(moveRight(at('a|b')))).toBe('ab|');
    expect(show(moveRight(at('ab|')))).toBe('ab|');
  });

  it('moves by word, skipping the boundary then the word', () => {
    expect(show(moveWordLeft(at('one two three|')))).toBe('one two |three');
    expect(show(moveWordLeft(at('one two |three')))).toBe('one |two three');
    expect(show(moveWordRight(at('|one two')))).toBe('one| two');
  });

  it('treats punctuation as a boundary, not a word', () => {
    expect(show(moveWordLeft(at('foo.bar|')))).toBe('foo.|bar');
  });

  it('goes to the start and end of the LINE, not the buffer', () => {
    expect(show(moveLineStart(at('one\ntw|o')))).toBe('one\n|two');
    expect(show(moveLineEnd(at('on|e\ntwo')))).toBe('one|\ntwo');
  });

  it('goes to the start and end of the whole buffer', () => {
    expect(show(moveDocStart(at('one\ntw|o')))).toBe('|one\ntwo');
    expect(show(moveDocEnd(at('on|e\ntwo')))).toBe('one\ntwo|');
  });
});

describe('vertical movement', () => {
  it('moves between lines keeping the column', () => {
    expect(show(moveUp(at('abcd\nef|gh')) as EditorState)).toBe('ab|cd\nefgh');
    expect(show(moveDown(at('ab|cd\nefgh')) as EditorState)).toBe('abcd\nef|gh');
  });

  it('returns null at the top and bottom instead of clamping', () => {
    // The caller needs "I could not move" to hand the key to the transcript.
    expect(moveUp(at('a|bc'))).toBeNull();
    expect(moveDown(at('a|bc'))).toBeNull();
    expect(moveUp(at('ab|c\ndef'))).toBeNull();
    expect(moveDown(at('abc\nde|f'))).toBeNull();
  });

  it('lands at the end of a line too short for the column', () => {
    expect(show(moveDown(at('abcdef|\nxy')) as EditorState)).toBe('abcdef\nxy|');
  });

  // The reason goalColumn exists: crossing a short line must not permanently lose the column.
  it('restores the original column after passing through a short line', () => {
    const start = at('abcdef|\nxy\nabcdef');
    const short = moveDown(start) as EditorState;
    expect(show(short)).toBe('abcdef\nxy|\nabcdef');

    const recovered = moveDown(short) as EditorState;
    expect(show(recovered)).toBe('abcdef\nxy\nabcdef|');
  });

  it('forgets the goal column once the caret is moved horizontally', () => {
    const short = moveDown(at('abcdef|\nxy\nabcdef')) as EditorState;
    const nudged = moveLeft(short);
    expect(show(moveDown(nudged) as EditorState)).toBe('abcdef\nxy\na|bcdef');
  });
});

describe('geometry', () => {
  it('reports the row and column the caret sits on', () => {
    const state = at('one\ntwo\nth|ree');
    expect(cursorRow(state)).toBe(2);
    expect(cursorColumn(state)).toBe(2);
  });

  it('starts a new row on a newline', () => {
    expect(cursorRow(insertNewline(fromText('abc')))).toBe(1);
    expect(cursorColumn(insertNewline(fromText('abc')))).toBe(0);
  });
});
