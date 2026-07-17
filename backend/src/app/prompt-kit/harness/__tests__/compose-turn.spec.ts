import { describe, it, expect } from 'vitest';

import { composeTurn } from '../compose-turn';
import { type TurnChunk } from '@shared/prompt-kit/harness/tag-vocabulary';

const userChunk = (name: string, body: string, at: string): TurnChunk => ({
  kind: 'user',
  body,
  attrs: { name, at },
});

describe('composeTurn', () => {
  it('(a) frames a lone operator message as a single <user> chunk with no prefix', () => {
    const turn = composeTurn({
      prefixChunks: [],
      userChunks: [userChunk('Dennis', 'ship it', '2026-07-04T00:00:00.000Z')],
    });
    expect(turn).toBe(
      '<user name="Dennis" at="2026-07-04T00:00:00.000Z">ship it</user>',
    );
  });

  it('(b) coalesces a batch of 3 into 3 chronological <user> chunks after any prefixes', () => {
    const turn = composeTurn({
      prefixChunks: [
        {
          kind: 'system_reminder',
          body: 'awareness: build is green',
          attrs: { reminderKind: 'awareness' },
        },
      ],
      userChunks: [
        userChunk('Dennis', 'first', '2026-07-04T00:00:01.000Z'),
        userChunk('Dennis', 'second', '2026-07-04T00:00:02.000Z'),
        userChunk('Ada', 'third', '2026-07-04T00:00:03.000Z'),
      ],
    });
    expect(turn).toBe(
      [
        '<system_reminder source="awareness">awareness: build is green</system_reminder>',
        '<user name="Dennis" at="2026-07-04T00:00:01.000Z">first</user>',
        '<user name="Dennis" at="2026-07-04T00:00:02.000Z">second</user>',
        '<user name="Ada" at="2026-07-04T00:00:03.000Z">third</user>',
      ].join('\n'),
    );
    // Chronological order among the coalesced <user> chunks is preserved (stable within kind).
    const order = ['first', 'second', 'third'].map((t) => turn.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('(c) renders a memory turn-prefix chunk (the JIT rail) before the <user> bubble', () => {
    const turn = composeTurn({
      prefixChunks: [
        {
          kind: 'system_reminder',
          body: 'memory: prefers pnpm',
          attrs: { reminderKind: 'memory' },
        },
      ],
      userChunks: [
        userChunk('Dennis', 'how do we build?', '2026-07-04T00:00:00.000Z'),
      ],
    });
    expect(turn).toBe(
      [
        '<system_reminder source="memory">memory: prefers pnpm</system_reminder>',
        '<user name="Dennis" at="2026-07-04T00:00:00.000Z">how do we build?</user>',
      ].join('\n'),
    );
    expect(turn.indexOf('source="memory"')).toBeLessThan(turn.indexOf('<user'));
  });

  it('orders notices → reminders → <user> regardless of input order (byte-identical to renderTurn framing)', () => {
    const turn = composeTurn({
      prefixChunks: [
        {
          kind: 'system_reminder',
          body: 'a reminder',
          attrs: { reminderKind: 'awareness' },
        },
        { kind: 'system_notice', body: 'a notice' },
      ],
      userChunks: [userChunk('Dennis', 'hi', '2026-07-04T00:00:00.000Z')],
    });
    expect(turn).toBe(
      [
        '<system_notice>a notice</system_notice>',
        '<system_reminder source="awareness">a reminder</system_reminder>',
        '<user name="Dennis" at="2026-07-04T00:00:00.000Z">hi</user>',
      ].join('\n'),
    );
  });

  it('renders `at` on a `system_notice`/`untrusted` prefix chunk when present, and omits it when absent (back-compat: existing callers never set it)', () => {
    const withAt = composeTurn({
      prefixChunks: [
        {
          kind: 'system_notice',
          body: 'a timestamped notice',
          attrs: { at: '2026-07-04T00:00:00.000Z' },
        },
        {
          kind: 'untrusted',
          body: 'external payload',
          attrs: { source: 'github', at: '2026-07-04T00:00:01.000Z' },
        },
      ],
      userChunks: [userChunk('Dennis', 'hi', '2026-07-04T00:00:02.000Z')],
    });
    expect(withAt).toBe(
      [
        '<system_notice at="2026-07-04T00:00:00.000Z">a timestamped notice</system_notice>',
        '<untrusted source="github" at="2026-07-04T00:00:01.000Z">external payload</untrusted>',
        '<user name="Dennis" at="2026-07-04T00:00:02.000Z">hi</user>',
      ].join('\n'),
    );

    const withoutAt = composeTurn({
      prefixChunks: [{ kind: 'system_notice', body: 'a plain notice' }],
      userChunks: [userChunk('Dennis', 'hi', '2026-07-04T00:00:00.000Z')],
    });
    expect(withoutAt).toBe(
      [
        '<system_notice>a plain notice</system_notice>',
        '<user name="Dennis" at="2026-07-04T00:00:00.000Z">hi</user>',
      ].join('\n'),
    );
  });
});
