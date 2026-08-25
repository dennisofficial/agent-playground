import { describe, expect, it } from 'bun:test';
import {
  EPageClaim,
  pageClaim,
  type DraftFacts,
  type VetoChord,
} from '../composer-veto.js';

function chord(flags: Partial<VetoChord> & { name: string }): VetoChord {
  return flags;
}

const TYPING: DraftFacts = { empty: false, caretAtTop: false, overlayOpen: false };
const BLANK: DraftFacts = { empty: true, caretAtTop: true, overlayOpen: false };

describe('what the page takes before the editor sees it', () => {
  it('takes a plain return as submit, and leaves every modified one to the editor', () => {
    expect(pageClaim(chord({ name: 'return' }), TYPING)).toBe(EPageClaim.submit);
    expect(pageClaim(chord({ name: 'return', shift: true }), TYPING)).toBeNull();
    expect(pageClaim(chord({ name: 'return', meta: true }), TYPING)).toBeNull();
    expect(pageClaim(chord({ name: 'return', ctrl: true }), TYPING)).toBeNull();
  });

  it('takes escape always — it means stop, whatever the draft holds', () => {
    expect(pageClaim(chord({ name: 'escape' }), TYPING)).toBe(EPageClaim.escape);
    expect(pageClaim(chord({ name: 'escape' }), BLANK)).toBe(EPageClaim.escape);
  });

  // ← and → are how you leave, and they are only free to mean that while there is nothing to move
  // a caret through. One character in the draft and they are ordinary movement again.
  it('takes ← and → only on an empty draft', () => {
    expect(pageClaim(chord({ name: 'left' }), BLANK)).toBe(EPageClaim.back);
    expect(pageClaim(chord({ name: 'right' }), BLANK)).toBe(EPageClaim.job);
    expect(pageClaim(chord({ name: 'left' }), TYPING)).toBeNull();
    expect(pageClaim(chord({ name: 'right' }), TYPING)).toBeNull();
  });

  /**
   * The one claim that depends on where the caret IS rather than on what the draft holds. This is
   * the bug the whole change exists for: `↑` has to walk the wrapped rows and only escape the box
   * once there is no row above.
   */
  it('takes ↑ only once the caret has no row above it', () => {
    expect(pageClaim(chord({ name: 'up' }), { ...TYPING, caretAtTop: true })).toBe(
      EPageClaim.pastTop,
    );
    expect(pageClaim(chord({ name: 'up' }), { ...TYPING, caretAtTop: false })).toBeNull();
  });

  it('never takes ↓ — the caret runs to the end of the draft and stops there', () => {
    expect(pageClaim(chord({ name: 'down' }), TYPING)).toBeNull();
    expect(pageClaim(chord({ name: 'down' }), BLANK)).toBeNull();
  });
});

/**
 * The readline bindings the native editor claims by default and Atlas has always meant differently.
 * Unclaimed, ctrl+u would delete to the line start instead of clearing the draft, and ctrl+b would
 * walk the caret left instead of jumping the transcript to the bottom.
 */
describe('the control keys Atlas has already spent', () => {
  it('takes them back from the editor', () => {
    expect(pageClaim(chord({ name: 'u', ctrl: true }), TYPING)).toBe(EPageClaim.clear);
    expect(pageClaim(chord({ name: 'b', ctrl: true }), TYPING)).toBe(EPageClaim.bottom);
    expect(pageClaim(chord({ name: 'h', ctrl: true }), TYPING)).toBe(EPageClaim.threads);
    expect(pageClaim(chord({ name: 'a', ctrl: true }), TYPING)).toBe(EPageClaim.accounts);
  });

  // ⌘V is the terminal's and arrives as an empty text paste when the clipboard holds a picture.
  it('takes ctrl+v, the only paste Atlas can see', () => {
    expect(pageClaim(chord({ name: 'v', ctrl: true }), TYPING)).toBe(EPageClaim.pasteImage);
  });

  it('leaves the editor the readline bindings Atlas never spent', () => {
    // ctrl+k, ctrl+w, ctrl+e, ⌘z — the editor's, and better than the versions we hand-rolled.
    expect(pageClaim(chord({ name: 'k', ctrl: true }), TYPING)).toBeNull();
    expect(pageClaim(chord({ name: 'w', ctrl: true }), TYPING)).toBeNull();
    expect(pageClaim(chord({ name: 'e', ctrl: true }), TYPING)).toBeNull();
    expect(pageClaim(chord({ name: 'z', super: true }), TYPING)).toBeNull();
  });
});

describe('the keymap toggle', () => {
  it('takes ? only on an empty draft, so typing a question stays safe mid-turn', () => {
    expect(pageClaim(chord({ name: '?' }), BLANK)).toBe(EPageClaim.shortcuts);
    expect(pageClaim(chord({ name: '?' }), TYPING)).toBeNull();
  });
});

/**
 * While the palette is up it owns ↑/↓/⏎/esc for choosing a command. The editor must not also move
 * its caret through the draft underneath — that was the whole reason the old code checked the
 * overlay before anything else.
 */
describe('with the command palette open', () => {
  const OVERLAY: DraftFacts = { empty: false, caretAtTop: false, overlayOpen: true };

  it('takes the arrows and ⏎ for the list', () => {
    expect(pageClaim(chord({ name: 'up' }), OVERLAY)).toBe(EPageClaim.overlayUp);
    expect(pageClaim(chord({ name: 'down' }), OVERLAY)).toBe(EPageClaim.overlayDown);
    expect(pageClaim(chord({ name: 'return' }), OVERLAY)).toBe(EPageClaim.overlayChoose);
    expect(pageClaim(chord({ name: 'escape' }), OVERLAY)).toBe(EPageClaim.escape);
  });

  it('still lets you type the command name', () => {
    expect(pageClaim(chord({ name: 'g' }), OVERLAY)).toBeNull();
  });
});

describe('ordinary typing', () => {
  it('is never claimed', () => {
    for (const name of ['a', 'z', '/', ' ', 'backspace', 'delete', 'tab']) {
      expect(pageClaim(chord({ name }), TYPING)).toBeNull();
    }
  });

  // ⌥← and ⌘← are the editor's, and reach it because the page claims bare arrows only.
  it('leaves modified arrows alone even on an empty draft', () => {
    expect(pageClaim(chord({ name: 'left', meta: true }), BLANK)).toBeNull();
    expect(pageClaim(chord({ name: 'left', super: true }), BLANK)).toBeNull();
  });
});
