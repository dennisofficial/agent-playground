/**
 * Parser for a Claude Agent SDK session transcript (the `<configDir>/projects/<slug>/<sessionId>.jsonl`
 * the in-container brain session writes to a HOST-mounted bind volume). Used by {@link TurnRecoveryService}
 * to recover a brain turn that COMPLETED inside the sandbox container but whose durable transcript blocks
 * were never persisted to `messages` — because the backend was restarted mid-stream, before
 * `TurnHarnessFactory.finish()` ran (blocks are persisted only at turn END).
 *
 * VERIFIED transcript shape (against a real session): the SDK writes ONE line per content block — each line
 * is `{ uuid, parentUuid, sessionId, timestamp, type, message:{ id, role, stop_reason, content:[ONE block] },
 * toolUseResult? }`. Blocks of one logical assistant message share `message.id` but each line has its OWN
 * top-level `uuid` (so the line `uuid` is a stable per-block identity). There is NO `result` line (the SDK
 * `{type:result}` summary is stream-only); a turn COMPLETED when its trailing assistant message reaches
 * `stop_reason:'end_turn'`. Tool results arrive as `user` lines with `content[].type==='tool_result'`.
 * Subagent (Task) content is SIDECHAINED to separate files, so a parent-session parse yields the brain's
 * text/thinking + the Task tool_use/result, but not the live-peeled subagent prose (acceptable degradation).
 *
 * This deliberately MIRRORS the live mapping in `engine-core.ts` (assistant content → text/thinking/tool_use;
 * user tool_result → pair by id) and the block shape in `turn-harness.service.ts`, so a recovered transcript
 * renders identically to a normally-persisted one.
 *
 * KNOWN fidelity gaps (vs the live path), both inherent to the durable JSONL: thinking blocks persist only
 * their `signature` (the plaintext `thinking` is empty — encrypted, stream-only), so recovery yields no
 * thinking text; and forwarded subagent prose lives in sidechain files (not the parent session), so only the
 * Task tool_use + its result are recovered. The operator-visible text + tool calls are fully recovered.
 */

/** One durable transcript block recovered from the JSONL — the shape `BlockSink.appendBlock` consumes. */
export interface RecoveredBlock {
  /** 'chat' (assistant text) | 'thinking' | 'tool'. */
  kind: 'chat' | 'thinking' | 'tool';
  text?: string;
  /** Always carries `sdkUuid` (the per-block identity) + `recovered:true`; tool blocks add `{id,name,input,result,isError,toolUseId}`. */
  meta: Record<string, unknown>;
  /** The SDK line timestamp (turn-time), used to order the recovered rows after the operator prompt. */
  emittedAt?: Date;
  /** `tool` blocks only: true once a `tool_result` line paired onto this call. Distinguishes an INTERRUPTED
   *  tool call (no result ever arrived — a turn cut off mid-call, e.g. a dangling `ask_question`, which the
   *  next turn re-issues) from a completed call whose result content happens to be null. */
  toolPaired?: boolean;
}

/** One turn of a session transcript — the blocks after ONE operator prompt, up to the next prompt. */
export interface TurnSlice {
  /** The operator prompt that opened this turn (string content or joined text blocks). */
  promptText?: string;
  /** The recovered blocks of this turn (assistant text/thinking + tool_use with paired results). */
  blocks: RecoveredBlock[];
  /** Whether this turn's trailing assistant message reached `stop_reason:'end_turn'` (the turn COMPLETED). */
  endedClean: boolean;
}

/** The whole session transcript, segmented into turns by operator prompt. */
export interface SessionTranscript {
  /** The session id read from the transcript (top-level `sessionId`), if present. */
  sessionId?: string;
  /** One entry per operator prompt, in order. Bookkeeping lines before the first prompt are ignored. */
  turns: TurnSlice[];
}

export interface TranscriptTail {
  /** The session id read from the transcript (top-level `sessionId`), if present. */
  sessionId?: string;
  /** The text of the LAST operator prompt (the anchor) — used to correlate this transcript to the thread's
   *  last durable operator message before recovering. A prompt may carry a prepended awareness/reset prefix,
   *  so callers should match with `endsWith`, not equality. Undefined when there is no operator prompt. */
  promptText?: string;
  /** How many operator prompts the transcript contains (a sanity signal; 0 ⇒ nothing to anchor on). */
  operatorPromptCount: number;
  /** The recovered blocks AFTER the last operator prompt — the (interrupted) turn's transcript. */
  blocks: RecoveredBlock[];
  /** Whether the tail's trailing assistant message reached `stop_reason:'end_turn'` (the turn COMPLETED). */
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

/** A `user` line that is the operator's prompt (text content), NOT a tool-result feedback message. */
function isOperatorPrompt(m: RawLine): boolean {
  if (m.type !== 'user' || m.toolUseResult != null) return false;
  const c = m.message?.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) {
    const blocks = c as Array<{ type?: string }>;
    return (
      blocks.some((b) => b?.type === 'text') &&
      !blocks.some((b) => b?.type === 'tool_result')
    );
  }
  return false;
}

/** Parse the JSONL into raw lines, skipping blanks and any incomplete/corrupt (half-written) line. */
function parseLines(jsonl: string): RawLine[] {
  const parsed: RawLine[] = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      parsed.push(JSON.parse(t) as RawLine);
    } catch {
      // Incomplete/corrupt line (e.g. the container was still appending): ignore it.
    }
  }
  return parsed;
}

/** Map ONE turn's raw lines (assistant content + `user` tool_result feedback) to durable blocks. Mirrors
 *  the live mapping in engine-core / turn-harness: assistant → text/thinking/tool_use, user tool_result
 *  paired onto the newest open tool block by id. */
function mapTurnBlocks(lines: RawLine[]): {
  blocks: RecoveredBlock[];
  endedClean: boolean;
} {
  const blocks: RecoveredBlock[] = [];
  let endedClean = false;

  for (const m of lines) {
    const emittedAt =
      typeof m.timestamp === 'string' ? new Date(m.timestamp) : undefined;
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
        if (
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim()
        ) {
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
        } else if (
          block.type === 'tool_use' &&
          typeof block.name === 'string'
        ) {
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
      // Edit/MultiEdit carry a `structuredPatch` (real file offsets) on the line's `toolUseResult` — mirror
      // engine-core and attach it so a recovered turn's diff gutter shows true line numbers, not 1-based.
      const patch = (
        m.toolUseResult as { structuredPatch?: unknown } | undefined
      )?.structuredPatch;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const toolUseId =
          typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        // Pair with the newest still-unpaired tool block (mirrors engine-core / turn-harness pairing).
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
            if (Array.isArray(patch) && patch.length)
              b.meta.structuredPatch = patch;
            break;
          }
        }
      }
    }
  }

  return { blocks, endedClean };
}

/**
 * Parse the WHOLE session transcript into turns, segmented by operator prompt (each turn = the blocks after
 * one prompt, up to the next). Used by the recovery backstop to back-fill a turn STRANDED in the middle of
 * the session — one interrupted before `end_turn` that a later operator prompt superseded, so the tail no
 * longer points at it. Bookkeeping lines before the first prompt are ignored; a half-written trailing line
 * is skipped (never throws).
 */
export function parseSessionTranscriptTurns(jsonl: string): SessionTranscript {
  const parsed = parseLines(jsonl);
  const sessionId = parsed.find(
    (m) => typeof m.sessionId === 'string',
  )?.sessionId;

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

/**
 * Parse a session transcript and return the TAIL — the blocks after the LAST operator prompt (the turn that
 * would have been lost) — plus whether that turn completed. A convenience view over
 * {@link parseSessionTranscriptTurns} (the tail = the last turn); a blank or unparseable trailing line is
 * skipped, so a half-written final line never throws or yields a corrupt block.
 */
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

/** The plain text of an operator prompt line (string content, or the joined text blocks). */
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
