import { describe, expect, it } from 'vitest';
import { streamingBlockKeys } from '../lib/streaming-caret';

type Block = {
  kind: string;
  key: string;
  done: boolean;
  parentToolUseId?: string;
};

const open = (kind: string, key: string): Block => ({ kind, key, done: false });
const closed = (kind: string, key: string): Block => ({
  kind,
  key,
  done: true,
});

describe('streamingBlockKeys', () => {
  it('streams only the LAST open text block when two are open (the multi-caret condition)', () => {
    const keys = streamingBlockKeys([open('text', 'text0'), open('text', 'text1')], true);
    expect(keys).toEqual(new Set(['text1']));
  });

  it('streams ONLY the tail when a thinking block is interleaved — the stream is linear', () => {
    // Previously this returned {text1, thinking0}: two carets, one of them on a thinking block the model
    // had already finished. Anything with a later block after it is done, whatever its flag says.
    const keys = streamingBlockKeys(
      [open('text', 'text0'), open('thinking', 'thinking0'), open('text', 'text1')],
      true,
    );
    expect(keys).toEqual(new Set(['text1']));
  });

  it('streams nothing while a tool call trails the text (the reported caret)', () => {
    // The exact shape on screen: prose, then the model moves on to tools. Text/thinking blocks are never
    // flagged done on the live path, so the old per-kind scan kept a caret blinking under finished prose.
    const keys = streamingBlockKeys(
      [open('text', 'text0'), open('tool', 'tool0')],
      true,
    );
    expect(keys).toEqual(new Set());
  });

  it('streams the trailing thinking block while the model reasons', () => {
    const keys = streamingBlockKeys(
      [closed('text', 'text0'), closed('tool', 'tool0'), open('thinking', 'thinking0')],
      true,
    );
    expect(keys).toEqual(new Set(['thinking0']));
  });

  it('returns empty when every block is done', () => {
    const keys = streamingBlockKeys(
      [closed('text', 'text0'), closed('thinking', 'thinking0')],
      true,
    );
    expect(keys).toEqual(new Set());
  });

  it('returns empty when the turn is not active', () => {
    const keys = streamingBlockKeys([open('text', 'text0'), open('text', 'text1')], false);
    expect(keys).toEqual(new Set());
  });

  it("ignores a trailing subagent (parentToolUseId-set) block, streaming the brain's own tail", () => {
    const keys = streamingBlockKeys(
      [
        open('text', 'text0'),
        { kind: 'text', key: 'sub0', done: false, parentToolUseId: 'task-1' },
      ],
      true,
    );
    expect(keys).toEqual(new Set(['text0']));
  });
});
