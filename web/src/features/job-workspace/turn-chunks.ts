/**
 * Client-side parser for the host→brain TURN-CHUNK VOCABULARY.
 *
 * The backend frames every injected turn as a small closed set of XML tags (see
 * `backend/src/app/stimulus/chunk-vocabulary.ts`): `<user name="…" at="…">`, `<system_notice>`,
 * `<system_reminder source="…">`, `<untrusted source="…" severity="…">`. That serialized string is what
 * the engine received — and it is exactly what the `agent_prompt` block surfaces. This module parses it
 * back into structured segments so the web can render each chunk with its own component (a notice row, a
 * reminder chip, a user bubble) instead of dumping raw tags at the operator.
 *
 * Keep the recognized tag set aligned with the backend `ChunkKind`. An unrecognized tag (a future kind, a
 * malformed body) falls back to a `raw` segment — correct-by-default: we only ever show raw when we have
 * no prettier rendering for that content.
 */

/** The closed set of recognized chunk kinds — must match the backend `ChunkKind`. */
export type ChunkKind = "user" | "system_notice" | "system_reminder" | "untrusted";

/** Parsed attributes (the union across all kinds; only the relevant ones are set per kind). */
export interface ChunkAttrs {
  /** `<user>` attribution. */
  name?: string;
  role?: string;
  at?: string;
  /** `<untrusted>` provenance. */
  source?: string;
  severity?: string;
}

/** One parsed piece of a serialized turn: a recognized chunk, or an un-parseable `raw` remainder. */
export type TurnSegment =
  | { kind: ChunkKind; attrs: ChunkAttrs; body: string }
  | { kind: "raw"; body: string };

const RECOGNIZED = new Set<string>([
  "user",
  "system_notice",
  "system_reminder",
  "untrusted",
]);

/** Next opening tag of the vocabulary, capturing the kind and its raw attribute string. */
const OPEN_TAG_RE = /<(user|system_notice|system_reminder|untrusted)\b([^>]*)>/i;

/** Extract `key="value"` pairs from an opening tag's attribute string (values are entity-escaped). */
const ATTR_RE = /([a-zA-Z_]+)="([^"]*)"/g;

/** Reverse of the backend `escapeAttr` — decode the entities it emits, `&amp;` last. */
function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseAttrs(raw: string): ChunkAttrs {
  const attrs: ChunkAttrs = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const key = m[1];
    const value = unescapeAttr(m[2]);
    if (
      key === "name" ||
      key === "role" ||
      key === "at" ||
      key === "source" ||
      key === "severity"
    ) {
      attrs[key] = value;
    }
  }
  return attrs;
}

/** Push a `raw` segment unless it is empty/whitespace-only (the `\n` glue between chunks). */
function pushRaw(out: TurnSegment[], body: string): void {
  if (body.trim().length > 0) out.push({ kind: "raw", body });
}

/**
 * Parse a serialized turn string into ordered segments. If no recognized tag is present the whole string
 * comes back as a single `raw` segment (identical to rendering the text directly — e.g. plain sub-lane
 * prompts that were never wrapped).
 */
export function parseTurnChunks(text: string): TurnSegment[] {
  const out: TurnSegment[] = [];
  let rest = text;

  while (rest.length > 0) {
    const open = OPEN_TAG_RE.exec(rest);
    if (!open || open.index === undefined) {
      pushRaw(out, rest);
      break;
    }

    // Anything before the opening tag is raw (dropped if it is just inter-chunk whitespace).
    if (open.index > 0) pushRaw(out, rest.slice(0, open.index));

    const kind = open[1].toLowerCase();
    const attrRaw = open[2] ?? "";
    const bodyStart = open.index + open[0].length;
    const close = `</${kind}>`;
    const closeIdx = rest.indexOf(close, bodyStart);

    if (closeIdx === -1) {
      // Malformed / no matching close — don't lose content: emit the remainder raw and stop.
      pushRaw(out, rest.slice(open.index));
      break;
    }

    const body = rest.slice(bodyStart, closeIdx).trim();
    if (RECOGNIZED.has(kind)) {
      out.push({ kind: kind as ChunkKind, attrs: parseAttrs(attrRaw), body });
    } else {
      // Unreachable given OPEN_TAG_RE, but keep the raw fallback honest.
      pushRaw(out, rest.slice(open.index, closeIdx + close.length));
    }

    rest = rest.slice(closeIdx + close.length);
  }

  return out;
}
