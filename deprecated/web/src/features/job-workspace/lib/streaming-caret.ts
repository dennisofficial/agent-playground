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
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.parentToolUseId != null) continue; // subagent block — rendered in its own card, not this tail
    if (b.done) return new Set(); // the tail is finished: nothing in this lane is streaming
    return b.kind === 'text' || b.kind === 'thinking' ? new Set([b.key]) : new Set();
  }
  return new Set();
}
