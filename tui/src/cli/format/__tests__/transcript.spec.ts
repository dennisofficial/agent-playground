import { describe, expect, it } from 'bun:test';
import {
  EMessageType,
  ESessionEndReason,
  EThreadRole,
  EThreadStatus,
} from '../../../generated/prisma/enums.js';
import type { Message, MessagePayload } from '../../../domain/message.js';
import type { TranscriptItem } from '../../../domain/seam.js';
import { TOOL_DETAIL_LINES, formatTranscript, type TranscriptHeader } from '../transcript.js';

const HEADER: TranscriptHeader = {
  threadId: 'thread-1',
  role: EThreadRole.builder,
  status: EThreadStatus.active,
  phaseId: 'phase-1',
  messageCount: 0,
  createdAt: new Date('2026-08-11T10:00:00.000Z'),
  closedAt: null,
};

function message(ordinal: number, payload: MessagePayload): TranscriptItem {
  const row: Message = {
    id: `m${ordinal}`,
    threadId: 'thread-1',
    sessionId: 'session-1',
    ordinal,
    payload,
    createdAt: new Date('2026-08-11T10:00:00.000Z'),
  };
  return { kind: 'message', message: row };
}

function render(items: TranscriptItem[], full = false): string {
  return formatTranscript({ header: { ...HEADER, messageCount: items.length }, items, full });
}

describe('formatTranscript', () => {
  it('heads with the thread, its role and its phase', () => {
    const text = render([]);
    expect(text).toContain('thread thread-1  role=builder  status=active');
    expect(text).toContain('phase phase-1  messages 0');
  });

  it('says a thread has never run rather than printing nothing', () => {
    expect(render([])).toContain('(no messages');
  });

  it('never trims prose — it is the whole reason a successor reads a predecessor', () => {
    const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const text = render([message(0, { type: EMessageType.assistant, text: long })]);
    expect(text).toContain('--- [0] assistant');
    expect(text).toContain('line 39');
  });

  it('keeps thinking and user prose too', () => {
    const text = render([
      message(0, { type: EMessageType.user, text: 'do the thing' }),
      message(1, { type: EMessageType.thinking, text: 'weighing it up' }),
    ]);
    expect(text).toContain('--- [0] user\ndo the thing');
    expect(text).toContain('--- [1] thinking\nweighing it up');
  });

  it('shows which call a tool_call was, and pairs it with its result by id', () => {
    const text = render([
      message(0, {
        type: EMessageType.tool_call,
        toolUseId: 'toolu_01',
        name: 'Read',
        target: 'src/foo.ts',
        input: { file_path: '/x/src/foo.ts' },
      }),
      message(1, {
        type: EMessageType.tool_result,
        toolUseId: 'toolu_01',
        ok: true,
        summary: 'Read 210 lines',
        detail: [],
      }),
    ]);
    expect(text).toContain('--- [0] tool_call Read(src/foo.ts)  id=toolu_01');
    expect(text).toContain('input {"file_path":"/x/src/foo.ts"}');
    expect(text).toContain('--- [1] tool_result  ok  id=toolu_01');
    expect(text).toContain('Read 210 lines');
  });

  it('marks a failed tool result loudly', () => {
    const text = render([
      message(0, {
        type: EMessageType.tool_result,
        toolUseId: 'toolu_01',
        ok: false,
        summary: 'No such file',
        detail: [],
      }),
    ]);
    expect(text).toContain('FAILED');
  });

  it('trims tool output — most of a transcript by volume, almost none of it by meaning', () => {
    const detail = Array.from({ length: TOOL_DETAIL_LINES + 5 }, (_, i) => `out ${i}`);
    const items = [
      message(0, {
        type: EMessageType.tool_result,
        toolUseId: 'toolu_01',
        ok: true,
        summary: 'Found 13 matches',
        detail,
      }),
    ];

    const trimmed = render(items);
    expect(trimmed).toContain(`out ${TOOL_DETAIL_LINES - 1}`);
    expect(trimmed).not.toContain(`out ${TOOL_DETAIL_LINES}`);
    expect(trimmed).toContain('… +5 lines (rerun with --full)');

    const full = render(items, true);
    expect(full).toContain(`out ${TOOL_DETAIL_LINES + 4}`);
    expect(full).not.toContain('rerun with --full');
  });

  it('renders an error block with its title and detail', () => {
    const text = render([
      message(0, {
        type: EMessageType.error,
        title: 'usage limit reached',
        detail: 'resets at 18:00',
      }),
    ]);
    expect(text).toContain('--- [0] error\nusage limit reached\nresets at 18:00');
  });

  it('draws the seam where the context restarted, with why the last session ended', () => {
    const text = formatTranscript({
      header: HEADER,
      items: [
        message(0, { type: EMessageType.assistant, text: 'before' }),
        { kind: 'seam', sessionId: 'session-2', ordinal: 2, endReason: ESessionEndReason.context_pressure },
        message(1, { type: EMessageType.assistant, text: 'after' }),
      ],
      full: false,
    });
    expect(text).toContain('=== session 2 begins — previous session ended: context_pressure');
  });

  it('numbers by thread ordinal, which stays continuous across a rotation', () => {
    const text = formatTranscript({
      header: HEADER,
      items: [
        message(7, { type: EMessageType.assistant, text: 'seven' }),
        { kind: 'seam', sessionId: 'session-2', ordinal: 2, endReason: null },
        message(8, { type: EMessageType.assistant, text: 'eight' }),
      ],
      full: false,
    });
    expect(text).toContain('--- [7] assistant');
    expect(text).toContain('--- [8] assistant');
  });
});
