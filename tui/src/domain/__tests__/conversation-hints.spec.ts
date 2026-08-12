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
  it('offers back and the keymap when there is nothing else going on', () => {
    expect(conversationHints(state())).toBe('← back · ? for shortcuts');
  });

  it('offers send once there is a draft', () => {
    expect(conversationHints(state({ draftLength: 4 }))).toBe('esc clear · ⏎ send');
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
      expect(form).toMatch(/esc|⏎|←|\?|ctrl/);
    }
  });
});
