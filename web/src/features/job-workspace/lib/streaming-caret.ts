/**
 * Which live blocks are genuinely still streaming — i.e. carry the caret / live "thinking…"state.
 * A turn can hold MORE THAN ONE open (!done) block of a kind at once (adaptive thinking interleaves a
 * thinking between text runs; an orphaned/re-attached turn can strand an earlier open block). Only
 * the SINGLE most-recent open of each kind is actually streaming, so return just those keys —
 * painting a caret on every open is the"multiple cursors" bug. Considers only the brain's own
 * blocks (parentToolUseId == null): subagent blocks are peeled into their own cards before render.
 */
export function streamingBlockKeys(
  blocks: ReadonlyArray<{
    kind: string;
    key: string;
    done: boolean;
    parentToolUseId?: string;
  }>,
  active: boolean,
): Set<string> {
  if (!active) return new Set();
  const keys = new Set<string>();
  for (const kind of ['text', 'thinking'] as const) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.parentToolUseId != null) continue; // subagent block — not rendered here
      if (b.kind === kind && !b.done) {
        keys.add(b.key);
        break;
      }
    }
  }
  return keys;
}
