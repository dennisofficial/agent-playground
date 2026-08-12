import { describe, expect, it } from 'bun:test';
import { conversationHints, type ConversationHintState } from '../conversation-hints.js';

function state(over: Partial<ConversationHintState> = {}): ConversationHintState {
  return {
    shortcutsOpen: false,
    threadClosed: false,
    clearArmed: false,
    running: false,
    queuedCount: 0,
    draftLength: 0,
    ...over,
  };
}

describe('conversationHints', () => {
  it('offers only the keymap when there is nothing else going on', () => {
    // `← back` went with the rest of the always-true hints. `?` stays because it is the one thing
    // you cannot guess: it is how you find every key that is not on this line.
    expect(conversationHints(state())).toBe('? for shortcuts');
  });

  it('says NOTHING once there is a draft', () => {
    // `⏎ send` and `esc clear` are true of every draft in every editor ever written. A line that is
    // always the same is a line you stop reading, which costs the hints that are not always true.
    expect(conversationHints(state({ draftLength: 4 }))).toBe('');
  });

  it('promises leaving does not interrupt, in the state where that matters', () => {
    expect(conversationHints(state({ running: true }))).toContain('leave it running');
  });

  it('names the queue key only when there is a queue to clear', () => {
    expect(conversationHints(state({ running: true, queuedCount: 2 }))).toContain('ctrl+u clear queue');
    expect(conversationHints(state({ running: true }))).not.toContain('ctrl+u');
  });

  it('answers the armed prompt even mid-turn — the user just asked it', () => {
    expect(conversationHints(state({ clearArmed: true, running: true }))).toBe(
      'esc again to clear the draft',
    );
  });

  it('never advertises send in a closed thread, whatever is in the draft', () => {
    const closed = conversationHints(state({ threadClosed: true, draftLength: 20 }));
    expect(closed).not.toContain('send');
    expect(closed).toBe('← back · ctrl+h threads');
  });

  it('lets the open keymap outrank everything — it is covering the screen', () => {
    expect(
      conversationHints(state({ shortcutsOpen: true, running: true, clearArmed: true })),
    ).toBe('? close');
  });

  it('only ever advertises keys, never a state — every form contains a key', () => {
    const forms = [
      state(),
      state({ draftLength: 1 }),
      state({ running: true }),
      state({ running: true, queuedCount: 1 }),
      state({ clearArmed: true }),
      state({ threadClosed: true }),
      state({ shortcutsOpen: true }),
    ].map(conversationHints);
    for (const form of forms) {
      // An empty line advertises nothing, which is the point of it — the rule is that a form must
      // not describe a STATE without naming the key that changes it.
      if (form.length === 0) continue;
      expect(form).toMatch(/esc|⏎|←|\?|ctrl/);
    }
  });
});
