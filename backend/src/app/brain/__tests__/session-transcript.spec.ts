import { describe, expect, it } from 'vitest';
import {
  isInterruptAbortResult,
  parseSessionTranscriptTail,
  parseSessionTranscriptTurns,
} from '../session-transcript';

/** Build one JSONL line (the SDK writes one content block per line). */
const line = (o: Record<string, unknown>): string => JSON.stringify(o);

/** A realistic transcript: queue/bookkeeping lines, an operator prompt, then an assistant turn that
 *  reasons (thinking), speaks (text), calls a tool, gets a result, and ends with `end_turn`. Mirrors the
 *  verified on-disk shape (shared `message.id`, per-line `uuid`, tool_result as a `user` line). */
const TRANSCRIPT = [
  line({ type: 'queue-operation', operation: 'enqueue', sessionId: 'sess-1' }),
  line({
    type: 'user',
    uuid: 'u-prompt',
    sessionId: 'sess-1',
    timestamp: '2026-06-29T15:11:00.000Z',
    message: { role: 'user', content: 'Do a deep dive review.' },
  }),
  line({
    type: 'assistant',
    uuid: 'a-think',
    sessionId: 'sess-1',
    timestamp: '2026-06-29T15:11:01.000Z',
    message: {
      id: 'msg_1',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'thinking', thinking: 'Let me look around.' }],
    },
  }),
  line({
    type: 'assistant',
    uuid: 'a-text1',
    sessionId: 'sess-1',
    timestamp: '2026-06-29T15:11:02.000Z',
    message: {
      id: 'msg_1',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Reading the repo now.' }],
    },
  }),
  line({
    type: 'assistant',
    uuid: 'a-tool',
    sessionId: 'sess-1',
    timestamp: '2026-06-29T15:11:03.000Z',
    message: {
      id: 'msg_1',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_42',
          name: 'Read',
          input: { file_path: 'README.md' },
        },
      ],
    },
  }),
  line({
    type: 'user',
    uuid: 'u-res',
    sessionId: 'sess-1',
    timestamp: '2026-06-29T15:11:04.000Z',
    toolUseResult: { ok: true },
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_42',
          content: '# OrthoScribe',
          is_error: false,
        },
      ],
    },
  }),
  line({
    type: 'assistant',
    uuid: 'a-final',
    sessionId: 'sess-1',
    timestamp: '2026-06-29T15:11:05.000Z',
    message: {
      id: 'msg_2',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here is the deep dive.' }],
    },
  }),
].join('\n');

describe('parseSessionTranscriptTail', () => {
  it('recovers the tail after the operator prompt, in order, with per-line sdkUuid identity', () => {
    const { blocks, endedClean, sessionId, operatorPromptCount } =
      parseSessionTranscriptTail(TRANSCRIPT);
    expect(sessionId).toBe('sess-1');
    expect(operatorPromptCount).toBe(1);
    expect(endedClean).toBe(true);
    expect(blocks.map((b) => b.kind)).toEqual([
      'thinking',
      'chat',
      'tool',
      'chat',
    ]);
    expect(blocks.map((b) => b.meta.sdkUuid)).toEqual([
      'a-think',
      'a-text1',
      'a-tool',
      'a-final',
    ]);
    expect(blocks.every((b) => b.meta.recovered === true)).toBe(true);
    // The operator prompt itself is NOT recovered (already persisted as a user message).
    expect(blocks.some((b) => b.text === 'Do a deep dive review.')).toBe(false);
  });

  it('pairs a tool_result onto its tool_use block by tool_use_id', () => {
    const { blocks } = parseSessionTranscriptTail(TRANSCRIPT);
    const tool = blocks.find((b) => b.kind === 'tool')!;
    expect(tool.meta).toMatchObject({
      id: 'toolu_42',
      name: 'Read',
      toolUseId: 'toolu_42',
      result: '# OrthoScribe',
      isError: false,
    });
  });

  it('marks endedClean=false when the trailing assistant message never reached end_turn', () => {
    const cutOff = TRANSCRIPT.split('\n').slice(0, 5).join('\n'); // drop the result + final end_turn lines
    const { endedClean, blocks } = parseSessionTranscriptTail(cutOff);
    expect(endedClean).toBe(false);
    expect(blocks.length).toBeGreaterThan(0); // partial blocks still parsed; caller decides not to persist
  });

  it('ignores a blank or half-written trailing line instead of throwing', () => {
    const withGarbage = `${TRANSCRIPT}\n{"type":"assistant","uuid":"a-partial","message":{"content":[{"type":"te`;
    const { blocks, endedClean } = parseSessionTranscriptTail(withGarbage);
    expect(endedClean).toBe(true); // the valid end_turn line still counts
    expect(blocks.some((b) => b.meta.sdkUuid === 'a-partial')).toBe(false); // the corrupt line is dropped
  });

  it('returns no blocks when the transcript has no operator prompt to anchor on', () => {
    const noPrompt = [
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'orphan' }],
        },
      }),
    ].join('\n');
    const { blocks, operatorPromptCount } =
      parseSessionTranscriptTail(noPrompt);
    expect(operatorPromptCount).toBe(0);
    expect(blocks).toEqual([]);
  });

  it('anchors on the LAST prompt when the session has multiple turns (only recovers the final one)', () => {
    const twoTurns = [
      line({
        type: 'user',
        uuid: 'p1',
        message: { role: 'user', content: 'first' },
      }),
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'first reply' }],
        },
      }),
      line({
        type: 'user',
        uuid: 'p2',
        message: { role: 'user', content: 'second' },
      }),
      line({
        type: 'assistant',
        uuid: 'a2',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'second reply' }],
        },
      }),
    ].join('\n');
    const { blocks } = parseSessionTranscriptTail(twoTurns);
    expect(blocks.map((b) => b.text)).toEqual(['second reply']);
  });
});

describe('parseSessionTranscriptTurns', () => {
  it('segments the session into one turn per operator prompt, in order', () => {
    const { sessionId, turns } = parseSessionTranscriptTurns(TRANSCRIPT);
    expect(sessionId).toBe('sess-1');
    expect(turns).toHaveLength(1);
    expect(turns[0].promptText).toBe('Do a deep dive review.');
    expect(turns[0].endedClean).toBe(true);
    expect(turns[0].blocks.map((b) => b.kind)).toEqual([
      'thinking',
      'chat',
      'tool',
      'chat',
    ]);
  });

  it('recovers a MIDDLE turn interrupted before end_turn, then superseded by a completed turn (the incident)', () => {
    const stranded = [
      line({
        type: 'user',
        uuid: 'p1',
        message: { role: 'user', content: 'investigate' },
      }),
      line({
        type: 'assistant',
        uuid: 'i-text',
        message: {
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: 'looking' }],
        },
      }),
      // dangling tool_use: no matching tool_result, no end_turn — the interruption point.
      line({
        type: 'assistant',
        uuid: 'i-ask',
        message: {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_ask',
              name: 'ask_question',
              input: {},
            },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'p2',
        message: { role: 'user', content: 'hello?' },
      }),
      line({
        type: 'assistant',
        uuid: 'h-final',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'sorry, finished' }],
        },
      }),
    ].join('\n');
    const { turns } = parseSessionTranscriptTurns(stranded);
    expect(turns).toHaveLength(2);
    // Turn 1 (the stranded investigation) never reached end_turn; turn 2 did.
    expect(turns[0].endedClean).toBe(false);
    expect(turns[1].endedClean).toBe(true);
    expect(turns[0].blocks.map((b) => b.meta.sdkUuid)).toEqual([
      'i-text',
      'i-ask',
    ]);
    // The dangling tool_use is unpaired — the caller drops it (the next turn re-issues it).
    const ask = turns[0].blocks.find((b) => b.kind === 'tool')!;
    expect(ask.toolPaired).toBe(false);
    expect(turns[1].blocks.map((b) => b.text)).toEqual(['sorry, finished']);
  });

  it('marks toolPaired=true once a tool_result lands on the tool_use', () => {
    const { turns } = parseSessionTranscriptTurns(TRANSCRIPT);
    const tool = turns[0].blocks.find((b) => b.kind === 'tool')!;
    expect(tool.toolPaired).toBe(true);
    expect(tool.meta).toMatchObject({
      id: 'toolu_42',
      result: '# OrthoScribe',
    });
  });

  it('tags a tool_result as superseded when it is the SDK mid-turn-interrupt cancellation', () => {
    const interrupted = [
      line({
        type: 'user',
        uuid: 'p1',
        message: { role: 'user', content: 'investigate' },
      }),
      line({
        type: 'assistant',
        uuid: 'a-tool',
        message: {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_int', name: 'Read', input: {} },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'u-res',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_int',
              content: 'AbortError: interrupt',
              is_error: true,
            },
          ],
        },
      }),
    ].join('\n');
    const { turns } = parseSessionTranscriptTurns(interrupted);
    const tool = turns[0].blocks.find((b) => b.kind === 'tool')!;
    expect(tool.meta.isError).toBe(true);
    expect(tool.meta.superseded).toBe(true);
  });

  it('does not tag a genuine tool error as superseded', () => {
    const genuine = [
      line({
        type: 'user',
        uuid: 'p1',
        message: { role: 'user', content: 'investigate' },
      }),
      line({
        type: 'assistant',
        uuid: 'a-tool',
        message: {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_err', name: 'Read', input: {} },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'u-res',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_err',
              content: 'Error: ENOENT no such file',
              is_error: true,
            },
          ],
        },
      }),
    ].join('\n');
    const { turns } = parseSessionTranscriptTurns(genuine);
    const tool = turns[0].blocks.find((b) => b.kind === 'tool')!;
    expect(tool.meta.isError).toBe(true);
    expect(tool.meta.superseded).toBeUndefined();
  });
});

describe('isInterruptAbortResult', () => {
  it('matches the MCP-prefixed AbortError form', () => {
    expect(
      isInterruptAbortResult('MCP error -32001: AbortError: interrupt'),
    ).toBe(true);
  });

  it('matches a bare AbortError: interrupt', () => {
    expect(isInterruptAbortResult('AbortError: interrupt')).toBe(true);
  });

  it('matches the SDK "user doesn\'t want to take this action" cancellation text', () => {
    expect(
      isInterruptAbortResult(
        "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
      ),
    ).toBe(true);
  });

  it('does not match an ordinary tool error', () => {
    expect(isInterruptAbortResult('Error: ENOENT no such file')).toBe(false);
  });

  it('does not match a normal, non-error result', () => {
    expect(isInterruptAbortResult('# OrthoScribe')).toBe(false);
  });
});
