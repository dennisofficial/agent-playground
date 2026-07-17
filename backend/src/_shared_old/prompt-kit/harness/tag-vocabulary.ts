export type ChunkKind = 'system_notice' | 'system_reminder' | 'user' | 'untrusted' | 'passthrough';

export interface TurnChunk {
  kind: ChunkKind;
  body: string;
  attrs?: {
    name?: string;
    role?: string;
    at?: string;
    source?: string;
    severity?: string;
    reminderKind?: string;
  };
}

const KIND_ORDER: Record<ChunkKind, number> = {
  system_notice: 0,
  system_reminder: 1,
  untrusted: 2,
  passthrough: 3,
  user: 4,
};

const STRIP_KINDS: ReadonlySet<ChunkKind> = new Set<ChunkKind>(['user', 'untrusted']);

const VOCAB_TAG_RE =
  /<\/?(?:system_notice|system_reminder|user|untrusted|context_pressure|session_rotated|resume_here|running_services)\b[^>]*>/gi;

export function stripTags(body: string): string {
  return body
    .replace(VOCAB_TAG_RE, '')
    .split('<<<UNTRUSTED_EVENT_DATA>>>')
    .join('')
    .split('<<<END_UNTRUSTED_EVENT_DATA>>>')
    .join('');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

type HarnessAttr = [name: string, value: string | number | undefined];

function renderHarnessAttrs(pairs: HarnessAttr[]): string {
  return pairs
    .filter((p): p is [string, string | number] => p[1] != null && p[1] !== '')
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join('');
}

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

function renderAttrs(chunk: TurnChunk): string {
  const a = chunk.attrs ?? {};
  const pairs: Array<[string, string | undefined]> = [];
  if (chunk.kind === 'user') {
    pairs.push(['name', a.name], ['role', a.role], ['at', a.at]);
  } else if (chunk.kind === 'untrusted') {
    pairs.push(['source', a.source], ['severity', a.severity], ['at', a.at]);
  } else if (chunk.kind === 'system_reminder') {
    pairs.push(['source', a.reminderKind]);
  } else if (chunk.kind === 'system_notice') {
    pairs.push(['at', a.at]);
  }
  const rendered = pairs
    .filter((p): p is [string, string] => p[1] != null && p[1] !== '')
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  return rendered;
}

export function renderChunk(chunk: TurnChunk): string {
  if (chunk.kind === 'passthrough') {
    const a = chunk.attrs ?? {};
    const header = a.name || a.at ? `[${a.name ?? ''} · ${a.at ?? ''}]\n` : '';
    return `${header}${chunk.body}`;
  }
  const body = STRIP_KINDS.has(chunk.kind) ? stripTags(chunk.body) : chunk.body;
  return `<${chunk.kind}${renderAttrs(chunk)}>${body}</${chunk.kind}>`;
}

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
