/**
 * What the footer offers, given everything the page currently is.
 *
 * A single ordered decision rather than a nest of ternaries in the render, because the ORDER is the
 * whole design: the most urgent state wins the line, and each hint names only keys that do something
 * right now. A hint advertising a key that no longer works is worse than no hint — it is the line
 * you learn the app from.
 */
export type ConversationHintState = {
  /** The keymap panel is open; the only thing worth saying is how to close it. */
  shortcutsOpen: boolean;
  /** A closed thread is a record. Nothing can be sent into it, so `⏎ send` must not appear. */
  threadClosed: boolean;
  /** Esc has been pressed once on a non-empty draft and is waiting for the second. */
  clearArmed: boolean;
  running: boolean;
  queuedCount: number;
  draftLength: number;
};

export function conversationHints(state: ConversationHintState): string {
  if (state.shortcutsOpen) return '? close';
  if (state.threadClosed) return '← back · ctrl+h threads';
  // Ahead of `running`: the armed prompt is a question the user just asked, and answering it late is
  // the same as not answering it.
  if (state.clearArmed) return 'esc again to clear the draft';

  if (state.running) {
    return state.queuedCount > 0
      ? 'ctrl+u clear queue · esc interrupt · ← leave'
      : // "leave it running" rather than "leave": the whole point of `←` here is that it does NOT
        // interrupt, and the one word is what makes that safe to try.
        'esc interrupt · ← leave it running';
  }

  if (state.draftLength > 0) return 'esc clear · ⏎ send';
  return '← back · ? for shortcuts';
}
