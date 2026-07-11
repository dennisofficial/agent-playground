/**
 * The TURN-CHUNK VOCABULARY. Everything the host injects into the brain's Claude Agent SDK session —
 * operator chat, system notices (sandbox reset, secret/file confirmations, answered questions),
 * harness reminders (pipeline awareness, open-questions, memory), and untrusted external data — ends
 * up as ONE "human" (user) SDK turn. This module is the single place that frames that turn as a small
 * closed set of XML tags, so:
 *
 *   1. The model reliably tells system-authored context from a real human (only `<user>` is a person).
 *   2. The web can parse-and-render each chunk distinctly (notice row, reminder chip, user bubble).
 *   3. The SDK session transcript is self-describing / rebuildable.
 *
 * The tag is the contract both edges agree on — it replaces the ad-hoc `wrapSystemNotification`
 * envelope and the untagged string-glue that used to be concatenated in `runChatTurnInner`.
 *
 * IMPORTANT: rendering happens ONLY at the engine-facing read of a turn — never at persistence. The
 * durable `messages.text` / `stimuli.body` stay CLEAN (a human's `<user>` wrap is reconstructed from
 * author fields at turn time), so a replayed stimulus renders byte-identically.
 */

/** The closed set of chunk kinds. `user` is the only human-authored kind. */
export type ChunkKind = 'system_notice' | 'system_reminder' | 'user' | 'untrusted';

/** One framed piece of a turn. `body` is the raw content; `attrs` become XML attributes. */
export interface TurnChunk {
  kind: ChunkKind;
  body: string;
  attrs?: {
    /** `<user>` attribution. `name` + `at` are wired now; `role` is provisioned for multi-operator. */
    name?: string;
    role?: string;
    at?: string;
    /** `<untrusted>` provenance. */
    source?: string;
    severity?: string;
    /** `<system_reminder>` sub-kind: `awareness` | `open_questions` | `memory`. Rendered as `source`. */
    reminderKind?: string;
  };
}

/** Render order — `<user>` is ALWAYS last (a reminder is "injected alongside" the human message). */
const KIND_ORDER: Record<ChunkKind, number> = {
  system_notice: 0,
  system_reminder: 1,
  untrusted: 2,
  user: 3,
};

/** Human/external kinds whose body is untrusted for tag-forgery purposes (a payload can't "break out"). */
const STRIP_KINDS: ReadonlySet<ChunkKind> = new Set<ChunkKind>(['user', 'untrusted']);

/** Any well-formed open/close tag of THIS vocabulary — used to neutralize forged boundaries. */
const VOCAB_TAG_RE =
  /<\/?(?:system_notice|system_reminder|user|untrusted|context_pressure|session_rotated|resume_here|review|uploaded-files|file|running_services)\b[^>]*>/gi;

/**
 * Remove any literal vocabulary tag from a body so an untrusted payload (or a human literally typing
 * `</user>`) can't forge the boundary and inject trailing instructions. Also strips the legacy
 * `<<<UNTRUSTED_EVENT_DATA>>>` fence tokens for good measure. Generalizes the old `stripFenceTokens`.
 */
export function stripTags(body: string): string {
  return body
    .replace(VOCAB_TAG_RE, '')
    .split('<<<UNTRUSTED_EVENT_DATA>>>')
    .join('')
    .split('<<<END_UNTRUSTED_EVENT_DATA>>>')
    .join('');
}

/** Escape a value for use inside a double-quoted XML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The extra harness XML tags folded into this one vocabulary (d9) — each semantically distinct but
 *  DEFINED and rendered here so the tag set is enumerable in one place and forgery-stripping is uniform. */
export const HARNESS_TAGS = [
  'context_pressure',
  'session_rotated',
  'resume_here',
  'review',
  'uploaded-files',
  'file',
  'running_services',
] as const;
export type HarnessTag = (typeof HARNESS_TAGS)[number];

/** One ordered attribute for a harness tag; undefined/empty values are dropped. */
type HarnessAttr = [name: string, value: string | number | undefined];

function renderHarnessAttrs(pairs: HarnessAttr[]): string {
  return pairs
    .filter((p): p is [string, string | number] => p[1] != null && p[1] !== '')
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join('');
}

/**
 * Render one folded harness tag. Block form (body given): `<tag attrs>\n{body}\n</tag>`. Self-closing
 * (body omitted): `{indent}<tag attrs />`. Attribute values are XML-escaped; `indent` prefixes a
 * self-closing row (for nested `<file />` rows inside `<uploaded-files>`).
 */
export function renderHarnessTag(input: {
  tag: HarnessTag;
  attrs?: HarnessAttr[];
  body?: string;
  indent?: string;
}): string {
  const attrStr = renderHarnessAttrs(input.attrs ?? []);
  if (input.body === undefined) return `${input.indent ?? ''}<${input.tag}${attrStr} />`;
  return `<${input.tag}${attrStr}>\n${input.body}\n</${input.tag}>`;
}

/** Build the ordered attribute string for a chunk (only defined attrs, in a stable order). */
function renderAttrs(chunk: TurnChunk): string {
  const a = chunk.attrs ?? {};
  const pairs: Array<[string, string | undefined]> = [];
  if (chunk.kind === 'user') {
    pairs.push(['name', a.name], ['role', a.role], ['at', a.at]);
  } else if (chunk.kind === 'untrusted') {
    pairs.push(['source', a.source], ['severity', a.severity]);
  } else if (chunk.kind === 'system_reminder') {
    // The reminder sub-kind surfaces as `source="awareness"` etc. in the tag.
    pairs.push(['source', a.reminderKind]);
  }
  const rendered = pairs
    .filter((p): p is [string, string] => p[1] != null && p[1] !== '')
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  return rendered;
}

/** Render ONE chunk to its XML tag. `user`/`untrusted` bodies are tag-stripped first. */
export function renderChunk(chunk: TurnChunk): string {
  const body = STRIP_KINDS.has(chunk.kind) ? stripTags(chunk.body) : chunk.body;
  return `<${chunk.kind}${renderAttrs(chunk)}>${body}</${chunk.kind}>`;
}

/**
 * Render an ordered envelope of chunks to the single engine-facing user-turn string. Ordering is
 * enforced here (notices → reminders → untrusted → user last), NOT left to call-site order; chunks of
 * the same kind keep their input order (so multiple coalesced `<user>` messages stay chronological).
 */
export function renderTurn(chunks: TurnChunk[]): string {
  return chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => {
      const byKind = KIND_ORDER[a.chunk.kind] - KIND_ORDER[b.chunk.kind];
      return byKind !== 0 ? byKind : a.index - b.index;
    })
    .map(({ chunk }) => renderChunk(chunk))
    .join('\n');
}
