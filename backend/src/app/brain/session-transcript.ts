
export interface RecoveredBlock {
  kind: 'chat' | 'thinking' | 'tool';
  text?: string;
  meta: Record<string, unknown>;
  emittedAt?: Date;
  toolPaired?: boolean;
}

export interface TurnSlice {
  promptText?: string;
  blocks: RecoveredBlock[];
  endedClean: boolean;
}

export interface SessionTranscript {
  sessionId?: string;
  turns: TurnSlice[];
}

export interface TranscriptTail {
  sessionId?: string;
  promptText?: string;
  operatorPromptCount: number;
  blocks: RecoveredBlock[];
  endedClean: boolean;
}

interface RawLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  toolUseResult?: unknown;
  message?: {
    id?: string;
    role?: string;
    stop_reason?: string | null;
    content?: unknown;
  };
}

export function isInterruptAbortResult(result: unknown): boolean {
  const s = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  return (
    s.includes('AbortError: interrupt') ||
    s.includes("The user doesn't want to take this action right now")
  );
}

function isOperatorPrompt(m: RawLine): boolean {
  if (m.type !== 'user' || m.toolUseResult != null) return false;
  const c = m.message?.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) {
    const blocks = c as Array<{ type?: string }>;
    return blocks.some((b) => b?.type === 'text') && !blocks.some((b) => b?.type === 'tool_result');
  }
  return false;
}

function parseLines(jsonl: string): RawLine[] {
  const parsed: RawLine[] = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      parsed.push(JSON.parse(t) as RawLine);
    } catch {
    }
  }
  return parsed;
}

function mapTurnBlocks(lines: RawLine[]): {
  blocks: RecoveredBlock[];
  endedClean: boolean;
} {
  const blocks: RecoveredBlock[] = [];
  let endedClean = false;

  for (const m of lines) {
    const emittedAt = typeof m.timestamp === 'string' ? new Date(m.timestamp) : undefined;
    const uuid = typeof m.uuid === 'string' ? m.uuid : undefined;
    const base = (): Record<string, unknown> => ({
      recovered: true,
      ...(uuid ? { sdkUuid: uuid } : {}),
    });

    if (m.type === 'assistant') {
      if (m.message?.stop_reason === 'end_turn') endedClean = true;
      const content = Array.isArray(m.message?.content)
        ? (m.message!.content as Array<Record<string, unknown>>)
        : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          blocks.push({
            kind: 'chat',
            text: block.text,
            meta: base(),
            ...(emittedAt ? { emittedAt } : {}),
          });
        } else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.trim()
        ) {
          blocks.push({
            kind: 'thinking',
            text: block.thinking,
            meta: base(),
            ...(emittedAt ? { emittedAt } : {}),
          });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const id = typeof block.id === 'string' ? block.id : '';
          blocks.push({
            kind: 'tool',
            meta: {
              ...base(),
              id,
              name: block.name,
              input: block.input ?? null,
              result: null,
              isError: false,
              toolUseId: id,
            },
            toolPaired: false,
            ...(emittedAt ? { emittedAt } : {}),
          });
        }
      }
    } else if (m.type === 'user') {
      const content = Array.isArray(m.message?.content)
        ? (m.message!.content as Array<Record<string, unknown>>)
        : [];
      const patch = (m.toolUseResult as { structuredPatch?: unknown } | undefined)?.structuredPatch;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (
            b.kind === 'tool' &&
            !b.toolPaired &&
            (b.meta.toolUseId === toolUseId || toolUseId === '')
          ) {
            b.toolPaired = true;
            b.meta.result = block.content ?? null;
            b.meta.isError = Boolean(block.is_error);
            if (b.meta.isError && isInterruptAbortResult(block.content)) b.meta.superseded = true;
            if (Array.isArray(patch) && patch.length) b.meta.structuredPatch = patch;
            break;
          }
        }
      }
    }
  }

  return { blocks, endedClean };
}

export function parseSessionTranscriptTurns(jsonl: string): SessionTranscript {
  const parsed = parseLines(jsonl);
  const sessionId = parsed.find((m) => typeof m.sessionId === 'string')?.sessionId;

  const promptIdx: number[] = [];
  parsed.forEach((m, i) => {
    if (isOperatorPrompt(m)) promptIdx.push(i);
  });

  const turns: TurnSlice[] = [];
  for (let k = 0; k < promptIdx.length; k++) {
    const start = promptIdx[k] + 1;
    const end = k + 1 < promptIdx.length ? promptIdx[k + 1] : parsed.length;
    const promptText = operatorPromptText(parsed[promptIdx[k]]);
    const { blocks, endedClean } = mapTurnBlocks(parsed.slice(start, end));
    turns.push({
      ...(promptText != null ? { promptText } : {}),
      blocks,
      endedClean,
    });
  }

  return { ...(sessionId ? { sessionId } : {}), turns };
}

export function parseSessionTranscriptTail(jsonl: string): TranscriptTail {
  const { sessionId, turns } = parseSessionTranscriptTurns(jsonl);
  const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(last?.promptText != null ? { promptText: last.promptText } : {}),
    operatorPromptCount: turns.length,
    blocks: last?.blocks ?? [],
    endedClean: last?.endedClean ?? false,
  };
}

function operatorPromptText(m: RawLine): string | undefined {
  const c = m.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }
  return undefined;
}
