import { EMessageType } from '../../generated/prisma/enums.js';
import type { EThreadRole, EThreadStatus } from '../../generated/prisma/enums.js';
import { stripCanary } from '../../domain/canary.js';
import type { Message, MessagePayload } from '../../domain/message.js';
import type { TranscriptItem } from '../../domain/seam.js';

/** Lines of a tool result kept without `--full`. Tool output is most of a transcript by volume and
 *  almost none of it by meaning — the summary line is what an archaeologist actually reads. */
export const TOOL_DETAIL_LINES = 8;

/** Characters of a tool call's input kept without `--full`. Enough to see WHICH call it was. */
export const TOOL_INPUT_CHARS = 400;

export type TranscriptHeader = {
  threadId: string;
  role: EThreadRole;
  status: EThreadStatus;
  phaseId: string;
  messageCount: number;
  createdAt: Date;
  closedAt: Date | null;
};

/**
 * One thread's transcript, read from the NORMALISED store rather than the raw tape: the tape's shape
 * differs per SDK by definition, it is keyed by the engine's own session id, and it is mostly
 * tool-result noise by volume. What archaeology wants is what the thread said and did.
 *
 * `[n]` is the message ordinal, which is thread-scoped — so it stays continuous across a session
 * rotation, and the seam lines below say where the context actually restarted.
 */
export function formatTranscript(args: {
  header: TranscriptHeader;
  items: readonly TranscriptItem[];
  full: boolean;
}): string {
  const { header, items, full } = args;
  const lines: string[] = [
    `thread ${header.threadId}  role=${header.role}  status=${header.status}`,
    `phase ${header.phaseId}  messages ${header.messageCount}`,
    `opened ${iso(header.createdAt)}${header.closedAt === null ? '' : `  closed ${iso(header.closedAt)}`}`,
  ];

  if (items.length === 0) lines.push('', '(no messages — this thread has never run a turn)');

  for (const item of items) {
    lines.push('');
    if (item.kind === 'seam') {
      const why = item.endReason === null ? 'unknown' : item.endReason;
      lines.push(`=== session ${item.ordinal} begins — previous session ended: ${why}`);
      continue;
    }
    lines.push(...messageBlock({ message: item.message, full }));
  }

  return lines.join('\n');
}

function messageBlock(args: { message: Message; full: boolean }): string[] {
  const { message, full } = args;
  const payload = message.payload;
  const head = `--- [${message.ordinal}] ${payload.type}`;

  switch (payload.type) {
    case EMessageType.user:
    case EMessageType.assistant:
    case EMessageType.thinking:
      // Prose is never trimmed: it is the whole reason a successor reads a predecessor's thread.
      // The canary comes off here and only here — this command is the second reader of the store
      // and it shares the TUI's one stripper, because two strippers would drift into two answers.
      return [head, stripCanary(payload.text)];

    case EMessageType.tool_call: {
      const target = payload.target === undefined ? '' : `(${payload.target})`;
      const input = JSON.stringify(payload.input) ?? '';
      return [
        `${head} ${payload.name}${target}  id=${payload.toolUseId}`,
        ...(input.length === 0 ? [] : [`input ${clip({ text: input, full })}`]),
      ];
    }

    case EMessageType.tool_result: {
      const detail = trim({ lines: payload.detail, full });
      return [
        `${head}  ${payload.ok ? 'ok' : 'FAILED'}  id=${payload.toolUseId}`,
        payload.summary,
        ...detail,
      ];
    }

    case EMessageType.error:
      return [head, payload.title, ...(payload.detail === undefined ? [] : [payload.detail])];

    default:
      // The payload union grows — harness messages arrive in a sibling ticket. A read command must
      // print a block it has never heard of rather than refuse to compile against it, for the same
      // reason `unreadablePayload` exists: a transcript is history and cannot be re-written.
      return [head, ...unknownText(message.payload)];
  }
}

function unknownText(payload: MessagePayload): string[] {
  // `harness` lands here today, which is a prose surface — so it strips like the others.
  if ('text' in payload && typeof payload.text === 'string') return [stripCanary(payload.text)];
  return [JSON.stringify(payload) ?? ''];
}

function trim(args: { lines: readonly string[]; full: boolean }): string[] {
  if (args.full || args.lines.length <= TOOL_DETAIL_LINES) return [...args.lines];
  const hidden = args.lines.length - TOOL_DETAIL_LINES;
  return [
    ...args.lines.slice(0, TOOL_DETAIL_LINES),
    `… +${hidden} line${hidden === 1 ? '' : 's'} (rerun with --full)`,
  ];
}

function clip(args: { text: string; full: boolean }): string {
  if (args.full || args.text.length <= TOOL_INPUT_CHARS) return args.text;
  return `${args.text.slice(0, TOOL_INPUT_CHARS)}… (rerun with --full)`;
}

function iso(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}
