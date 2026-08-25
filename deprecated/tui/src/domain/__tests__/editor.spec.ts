import { describe, expect, it } from 'bun:test';
import { applyKey } from '../editor.js';
import type { KeyChord } from '../editor-keymap.js';
import { EMPTY_EDITOR, type EditorState } from '../text-editor.js';

function at(marked: string): EditorState {
  const cursor = marked.indexOf('|');
  return { text: marked.replace('|', ''), cursor, goalColumn: null };
}

function show(state: EditorState): string {
  return `${state.text.slice(0, state.cursor)}|${state.text.slice(state.cursor)}`;
}

function chord(flags: Partial<KeyChord>): KeyChord {
  return flags;
}

describe('typing', () => {
  it('inserts a character and consumes the key', () => {
    const result = applyKey(at('ab|'), 'c', chord({}));
    expect(result.consumed).toBe(true);
    expect(show(result.next)).toBe('abc|');
  });

  it('inserts a whole paste in one go', () => {
    const result = applyKey(EMPTY_EDITOR, 'one\ntwo', chord({}));
    expect(result.consumed).toBe(true);
    expect(result.next.text).toBe('one\ntwo');
  });

  it('ignores a stray control character rather than inserting garbage', () => {
    const result = applyKey(at('ab|'), String.fromCharCode(1), chord({}));
    expect(result.consumed).toBe(false);
    expect(result.next.text).toBe('ab');
  });

  // Ink strips the ESC from sequences it cannot name and passes the rest through as input, so an
  // unhandled key would otherwise type its own escape code into the draft.
  it('never types an unrecognised escape sequence into the draft', () => {
    for (const remnant of ['[1;3D', '[200~', '[15;2u']) {
      const result = applyKey(at('ab|'), remnant, chord({}));
      expect(result.consumed).toBe(false);
      expect(result.next.text).toBe('ab');
    }
  });

  it('still accepts bracket text a person could plausibly type or paste', () => {
    expect(applyKey(at('|'), '[', chord({})).next.text).toBe('[');
    expect(applyKey(at('|'), '[todo]', chord({})).next.text).toBe('[todo]');
    expect(applyKey(at('|'), 'arr[0]', chord({})).next.text).toBe('arr[0]');
  });
});

// The arbitration rule: anything the composer cannot use falls through to the transcript.
describe('what the composer declines', () => {
  it('declines every navigation key while empty, so they scroll instead', () => {
    for (const key of [
      { upArrow: true },
      { downArrow: true },
      { leftArrow: true },
      { rightArrow: true },
      { home: true },
      { end: true },
    ]) {
      expect(applyKey(EMPTY_EDITOR, '', chord(key)).consumed).toBe(false);
    }
  });

  it('declines ↑ on the first line and ↓ on the last', () => {
    expect(applyKey(at('ab|c\ndef'), '', chord({ upArrow: true })).consumed).toBe(false);
    expect(applyKey(at('abc\nde|f'), '', chord({ downArrow: true })).consumed).toBe(false);
  });

  it('claims ↑ and ↓ in the middle of a multi-line draft', () => {
    const up = applyKey(at('abc\nde|f'), '', chord({ upArrow: true }));
    expect(up.consumed).toBe(true);
    expect(show(up.next)).toBe('ab|c\ndef');

    const down = applyKey(at('ab|c\ndef'), '', chord({ downArrow: true }));
    expect(down.consumed).toBe(true);
    expect(show(down.next)).toBe('abc\nde|f');
  });

  // Horizontal movement is claimed even at the edge: the composer plainly owns ← / → once there is
  // text, and letting them leak to the transcript would be baffling.
  it('claims ← and → even when the caret cannot move', () => {
    expect(applyKey(at('|abc'), '', chord({ leftArrow: true })).consumed).toBe(true);
    expect(applyKey(at('abc|'), '', chord({ rightArrow: true })).consumed).toBe(true);
  });

  it('declines Escape, leaving interrupt to the page', () => {
    expect(applyKey(at('abc|'), '', chord({ escape: true, meta: true })).consumed).toBe(false);
  });

  it('declines a plain Return, leaving submit to the page', () => {
    expect(applyKey(at('abc|'), '', chord({ return: true })).consumed).toBe(false);
  });
});

describe('multi-line composition', () => {
  it('opens a new line on shift+return, however the terminal encodes it', () => {
    // Ghostty / kitty / WezTerm — Ink names it.
    const kitty = applyKey(at('one|'), '[13;2u', chord({ return: true, shift: true }));
    expect(show(kitty.next)).toBe('one\n|');

    // iTerm2 — Ink cannot name it, only the raw bytes arrive.
    const iterm = applyKey(at('one|'), '[27;2;13~', chord({}));
    expect(iterm.consumed).toBe(true);
    expect(show(iterm.next)).toBe('one\n|');

    // ctrl+j — the universal fallback, no terminal cooperation needed.
    const linefeed = applyKey(at('one|'), String.fromCharCode(10), chord({}));
    expect(show(linefeed.next)).toBe('one\n|');
  });

  it('opens a new line on opt+return without sending', () => {
    const result = applyKey(at('one|'), '', chord({ return: true, meta: true }));
    expect(result.consumed).toBe(true);
    expect(show(result.next)).toBe('one\n|');
  });

  it('word-deletes back across a line it just opened', () => {
    const result = applyKey(at('one two|'), '', chord({ delete: true, meta: true }));
    expect(show(result.next)).toBe('one |');
  });
});
