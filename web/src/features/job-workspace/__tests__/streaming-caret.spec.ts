import { describe, expect, it } from 'vitest';
import { streamingBlockKeys } from '../streaming-caret';

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

  it('streams the last open block of EACH kind (interleaved thinking)', () => {
    const keys = streamingBlockKeys(
      [open('text', 'text0'), open('thinking', 'thinking0'), open('text', 'text1')],
      true,
    );
    expect(keys).toEqual(new Set(['text1', 'thinking0']));
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
