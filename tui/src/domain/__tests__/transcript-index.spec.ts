import { describe, expect, it } from 'bun:test';
import { attachmentExpandKey } from '../attachments.js';
import { EHarnessVariant, type Message } from '../message.js';
import { EMessageType } from '../../generated/prisma/enums.js';
import { expandableIds, toolResultsById } from '../transcript-index.js';

/**
 * What `x` / `X` can reach.
 *
 * The failure this exists to catch is silent: a chip stored under one key and read under another
 * draws collapsed and stays collapsed forever, and a mounted page renders perfectly while doing it.
 * So the assertions below are deliberately about the KEY, compared against `attachmentExpandKey`
 * itself — the same function `message-view.tsx` asks with.
 */

function message(args: {
  id: string;
  payload: Message['payload'];
}): Message {
  return { id: args.id, payload: args.payload } as unknown as Message;
}

const FILE = [
  { label: 'context/specs/plan.md', lines: 1, bytes: 8, body: 'the plan' },
];

describe('expandableIds', () => {
  it('gives a seam message’s attachments the key the block reads them back under', () => {
    const ids = expandableIds([
      message({
        id: 'm-1',
        payload: {
          type: EMessageType.harness,
          variant: EHarnessVariant.handoff,
          text: 'here is where you are',
          attachments: FILE,
        },
      }),
    ]);

    expect(ids).toEqual([attachmentExpandKey('m-1')]);
    // Namespaced, so it can share one set with tool blocks and never collide with a `toolUseId`.
    expect(ids[0]).not.toBe('m-1');
  });

  it('offers nothing for a seam message that carried no files', () => {
    // An id here would be a keypress that appears to do nothing, and it would make `X`'s
    // all-expanded test count a message that can never be expanded.
    const ids = expandableIds([
      message({
        id: 'm-1',
        payload: {
          type: EMessageType.harness,
          variant: EHarnessVariant.seed,
          text: 'opening words',
        },
      }),
      message({
        id: 'm-2',
        payload: {
          type: EMessageType.harness,
          variant: EHarnessVariant.handoff,
          text: 'nothing attached',
          attachments: [],
        },
      }),
    ]);

    expect(ids).toEqual([]);
  });

  it('interleaves chips and tool blocks in the order they were said', () => {
    const ids = expandableIds([
      message({
        id: 'm-1',
        payload: {
          type: EMessageType.tool_call,
          toolUseId: 'tool-1',
          name: 'Read',
          input: {},
        },
      }),
      message({
        id: 'm-2',
        payload: {
          type: EMessageType.harness,
          variant: EHarnessVariant.handoff,
          text: 'a hand-off',
          attachments: FILE,
        },
      }),
      message({
        id: 'm-3',
        payload: {
          type: EMessageType.assistant,
          text: 'prose, which opens nothing',
        },
      }),
    ]);

    // Order is the whole contract with `x`: it opens the LAST id, and "the last thing that
    // appeared" is what a reader means by it — here, the chip rather than the tool block.
    expect(ids).toEqual(['tool-1', attachmentExpandKey('m-2')]);
    expect(ids[ids.length - 1]).toBe(attachmentExpandKey('m-2'));
  });

  it('round-trips through the expansion set the page actually holds', () => {
    const messages = [
      message({
        id: 'm-1',
        payload: {
          type: EMessageType.harness,
          variant: EHarnessVariant.handoff,
          text: 'a hand-off',
          attachments: FILE,
        },
      }),
    ];
    const ids = expandableIds(messages);
    const key = ids[ids.length - 1] as string;

    // `x`: toggle the last id — the page's `toggleTool`, which is a plain set toggle.
    const afterX = new Set([key]);
    expect(afterX.has(attachmentExpandKey('m-1'))).toBe(true);
    // `X` collapses all when everything is open, and expands all otherwise.
    expect(ids.every((id) => afterX.has(id))).toBe(true);
    afterX.delete(key);
    expect(afterX.has(attachmentExpandKey('m-1'))).toBe(false);
  });
});

describe('toolResultsById', () => {
  it('keys each result by the call it answers, and ignores everything else', () => {
    const results = toolResultsById([
      message({
        id: 'm-1',
        payload: { type: EMessageType.tool_call, toolUseId: 't-1', name: 'Read', input: {} },
      }),
      message({
        id: 'm-2',
        payload: {
          type: EMessageType.tool_result,
          toolUseId: 't-1',
          ok: true,
          summary: 'read 12 lines',
          detail: [],
        },
      }),
      message({ id: 'm-3', payload: { type: EMessageType.assistant, text: 'done' } }),
    ]);

    expect(results.size).toBe(1);
    expect(results.get('t-1')?.summary).toBe('read 12 lines');
  });
});
