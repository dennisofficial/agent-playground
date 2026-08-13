import { describe, expect, it } from 'bun:test';
import { isMovement, resolveEditorCommand, type KeyChord } from '../editor-keymap.js';

/** Only the flags a case cares about; everything else is false, as Ink reports it. */
function chord(flags: Partial<KeyChord>): KeyChord {
  return flags;
}

describe('word movement', () => {
  it('binds opt+arrow, which Ink reports as a modified arrow plus meta', () => {
    expect(resolveEditorCommand('', chord({ leftArrow: true, meta: true }))).toBe('move-word-left');
    expect(resolveEditorCommand('', chord({ rightArrow: true, meta: true }))).toBe(
      'move-word-right',
    );
  });

  it('binds ctrl+arrow, which is what some terminals send for the same intent', () => {
    expect(resolveEditorCommand('', chord({ leftArrow: true, ctrl: true }))).toBe('move-word-left');
  });

  // Terminal.app with "Use Option as Meta" sends the readline bindings instead of modified arrows.
  it('binds Meta-b / Meta-f for Terminal.app', () => {
    expect(resolveEditorCommand('b', chord({ meta: true }))).toBe('move-word-left');
    expect(resolveEditorCommand('f', chord({ meta: true }))).toBe('move-word-right');
  });

  // OpenTUI blanks the input of anything ESC-prefixed — `ESC b` arrives named `b` and typed as
  // nothing — so reading only `input` left this binding unreachable outside Ink.
  it('binds Meta-b / Meta-f reported as a NAME rather than as input', () => {
    expect(resolveEditorCommand('', chord({ name: 'b', meta: true }))).toBe('move-word-left');
    expect(resolveEditorCommand('', chord({ name: 'f', meta: true }))).toBe('move-word-right');
    expect(resolveEditorCommand('', chord({ name: 'd', meta: true }))).toBe('delete-word-forward');
  });

  it('leaves a plain b or f as ordinary typing', () => {
    expect(resolveEditorCommand('b', chord({}))).toBeNull();
  });
});

describe('line and document movement', () => {
  it('binds Home and End, the portable line-start/line-end keys', () => {
    expect(resolveEditorCommand('', chord({ home: true }))).toBe('move-line-start');
    expect(resolveEditorCommand('', chord({ end: true }))).toBe('move-line-end');
  });

  // cmd only exists as its own modifier under the kitty protocol, where Ink reports it as `super`.
  it('binds cmd+arrow to line start/end when the terminal reports super', () => {
    expect(resolveEditorCommand('', chord({ leftArrow: true, super: true }))).toBe(
      'move-line-start',
    );
    expect(resolveEditorCommand('', chord({ rightArrow: true, super: true }))).toBe('move-line-end');
  });

  it('binds cmd+up/down to the ends of the whole draft', () => {
    expect(resolveEditorCommand('', chord({ upArrow: true, super: true }))).toBe('move-doc-start');
    expect(resolveEditorCommand('', chord({ downArrow: true, super: true }))).toBe('move-doc-end');
  });

  it('binds ctrl+Home / ctrl+End to the ends of the whole draft', () => {
    expect(resolveEditorCommand('', chord({ home: true, ctrl: true }))).toBe('move-doc-start');
    expect(resolveEditorCommand('', chord({ end: true, ctrl: true }))).toBe('move-doc-end');
  });

  it('binds plain arrows to plain movement', () => {
    expect(resolveEditorCommand('', chord({ leftArrow: true }))).toBe('move-left');
    expect(resolveEditorCommand('', chord({ upArrow: true }))).toBe('move-up');
    expect(resolveEditorCommand('', chord({ downArrow: true }))).toBe('move-down');
  });
});

// One key, three wire encodings, because terminals cannot agree about shift+Return.
describe('newline', () => {
  it('binds shift+return as Ghostty/kitty/WezTerm report it (ESC[13;2u)', () => {
    expect(resolveEditorCommand('[13;2u', chord({ return: true, shift: true }))).toBe(
      'insert-newline',
    );
  });

  // iTerm2's default: Ink cannot name it, so only the raw bytes arrive. Unclaimed, this TYPES
  // `[27;2;13~` into the draft — the exact bug this binding exists to prevent.
  it('binds shift+return as iTerm2 reports it (ESC[27;2;13~), which Ink cannot name', () => {
    expect(resolveEditorCommand('[27;2;13~', chord({}))).toBe('insert-newline');
  });

  it('binds the modifyOtherKeys form for any modifier, not just shift', () => {
    expect(resolveEditorCommand('[27;5;13~', chord({}))).toBe('insert-newline');
  });

  it('binds opt+return, the Terminal.app fallback', () => {
    expect(resolveEditorCommand('', chord({ return: true, meta: true }))).toBe('insert-newline');
  });

  it('binds ctrl+return', () => {
    expect(resolveEditorCommand('', chord({ return: true, ctrl: true }))).toBe('insert-newline');
  });

  // ctrl+j IS the line-feed character, so it needs no terminal cooperation at all.
  it('binds ctrl+j, which works in every terminal', () => {
    expect(resolveEditorCommand(String.fromCharCode(10), chord({}))).toBe('insert-newline');
  });

  // Plain Return must reach the page as "send" — claiming it here would break submitting.
  it('leaves a plain Return alone', () => {
    expect(resolveEditorCommand(String.fromCharCode(13), chord({ return: true }))).toBeNull();
  });
});

describe('deletion', () => {
  it('treats both backspace flags as rub-out, since Ink reports plain Backspace as delete', () => {
    expect(resolveEditorCommand('', chord({ backspace: true }))).toBe('delete-backward');
    expect(resolveEditorCommand('', chord({ delete: true }))).toBe('delete-backward');
  });

  it('binds opt+backspace to a whole word', () => {
    expect(resolveEditorCommand('', chord({ delete: true, meta: true }))).toBe(
      'delete-word-backward',
    );
  });

  it('binds ctrl+w and ctrl+k', () => {
    expect(resolveEditorCommand('w', chord({ ctrl: true }))).toBe('delete-word-backward');
    expect(resolveEditorCommand('k', chord({ ctrl: true }))).toBe('delete-to-line-end');
  });
});

describe('keys that belong to the app, not the editor', () => {
  // Ink sets `meta` on a bare Escape, so an unguarded meta test would turn interrupt into an edit.
  it('never claims Escape, despite Ink reporting it as meta', () => {
    expect(resolveEditorCommand('', chord({ escape: true, meta: true }))).toBeNull();
  });

  it('leaves ctrl+a and ctrl+u to the accounts page and the composer clear', () => {
    expect(resolveEditorCommand('a', chord({ ctrl: true }))).toBeNull();
    expect(resolveEditorCommand('u', chord({ ctrl: true }))).toBeNull();
  });

  it('leaves ordinary typing alone', () => {
    expect(resolveEditorCommand('x', chord({}))).toBeNull();
    expect(resolveEditorCommand('/', chord({}))).toBeNull();
  });
});

describe('isMovement', () => {
  it('separates the commands that may fall through to the transcript', () => {
    expect(isMovement('move-up')).toBe(true);
    expect(isMovement('move-line-start')).toBe(true);
    expect(isMovement('delete-backward')).toBe(false);
    expect(isMovement('insert-newline')).toBe(false);
  });
});
