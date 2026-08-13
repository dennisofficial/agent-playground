import { describe, expect, it } from 'bun:test';
import type { Message } from '../message.js';
import { EMessageType } from '../../generated/prisma/enums.js';
import { inFlightToolIds, toolResultsById } from '../transcript-index.js';

function message(args: {
  id: string;
  payload: Message['payload'];
}): Message {
  return { id: args.id, payload: args.payload } as unknown as Message;
}

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

describe('inFlightToolIds', () => {
  it('names the calls with no result, which is what a group draws with a spinner', () => {
    const ids = inFlightToolIds([
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
          summary: 'done',
          detail: [],
        },
      }),
      // Two calls in flight at once — one assistant frame can carry a batch, which is why this is
      // derived from the messages rather than read off `runningTool`, a field that holds one.
      message({
        id: 'm-3',
        payload: { type: EMessageType.tool_call, toolUseId: 't-2', name: 'Read', input: {} },
      }),
      message({
        id: 'm-4',
        payload: { type: EMessageType.tool_call, toolUseId: 't-3', name: 'Bash', input: {} },
      }),
    ]);

    expect(ids).toEqual(new Set(['t-2', 't-3']));
  });

  it('is empty when everything answered', () => {
    expect(
      inFlightToolIds([
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
            summary: 'done',
            detail: [],
          },
        }),
      ]),
    ).toEqual(new Set());
  });
});
