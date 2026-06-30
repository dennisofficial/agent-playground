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
    return blocks.some((b) => b?.type === 'text') && !blocks.some((b) => b?.type === 'tool_result');
  }
  return false;
}

/**
 * Parse a session transcript and return the TAIL — the blocks after the LAST operator prompt (the turn that
 * would have been lost) — plus whether that turn completed. A blank or unparseable trailing line (a turn
 * still being written by a live container, or a partial flush) is skipped, so a half-written final line never
 * throws or yields a corrupt block.
 */
export function parseSessionTranscriptTail(jsonl: string): TranscriptTail {
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

  let lastPromptIdx = -1;
  let operatorPromptCount = 0;
  parsed.forEach((m, i) => {
    if (isOperatorPrompt(m)) {
      lastPromptIdx = i;
      operatorPromptCount++;
    }
  });

  const sessionId = parsed.find((m) => typeof m.sessionId === 'string')?.sessionId;
  const promptText = lastPromptIdx >= 0 ? operatorPromptText(parsed[lastPromptIdx]) : undefined;
  const tail = lastPromptIdx >= 0 ? parsed.slice(lastPromptIdx + 1) : [];

  const blocks: RecoveredBlock[] = [];
  let endedClean = false;

  for (const m of tail) {
    const emittedAt = typeof m.timestamp === 'string' ? new Date(m.timestamp) : undefined;
    const uuid = typeof m.uuid === 'string' ? m.uuid : undefined;
    const base = (): Record<string, unknown> => ({ recovered: true, ...(uuid ? { sdkUuid: uuid } : {}) });

    if (m.type === 'assistant') {
      if (m.message?.stop_reason === 'end_turn') endedClean = true;
      const content = Array.isArray(m.message?.content) ? (m.message!.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          blocks.push({ kind: 'chat', text: block.text, meta: base(), ...(emittedAt ? { emittedAt } : {}) });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          blocks.push({ kind: 'thinking', text: block.thinking, meta: base(), ...(emittedAt ? { emittedAt } : {}) });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const id = typeof block.id === 'string' ? block.id : '';
          blocks.push({
            kind: 'tool',
            meta: { ...base(), id, name: block.name, input: block.input ?? null, result: null, isError: false, toolUseId: id },
            ...(emittedAt ? { emittedAt } : {}),
          });
        }
      }
    } else if (m.type === 'user') {
      const content = Array.isArray(m.message?.content) ? (m.message!.content as Array<Record<string, unknown>>) : [];
      // Edit/MultiEdit carry a `structuredPatch` (real file offsets) on the line's `toolUseResult` — mirror
      // engine-core and attach it so a recovered turn's diff gutter shows true line numbers, not 1-based.
      const patch = (m.toolUseResult as { structuredPatch?: unknown } | undefined)?.structuredPatch;
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        // Pair with the newest still-unpaired tool block (mirrors engine-core / turn-harness pairing).
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && b.meta.result == null && (b.meta.toolUseId === toolUseId || toolUseId === '')) {
            b.meta.result = block.content ?? null;
            b.meta.isError = Boolean(block.is_error);
            if (Array.isArray(patch) && patch.length) b.meta.structuredPatch = patch;
            break;
          }
        }
      }
    }
  }

  return {
    ...(sessionId ? { sessionId } : {}),
    ...(promptText != null ? { promptText } : {}),
    operatorPromptCount,
    blocks,
    endedClean,
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
